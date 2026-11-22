// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  dmHookSessionContext,
  hasSharedDmHistory,
  isSharedMainSessionKey,
  resolveSharedDmKey,
  selectSharedDmHistory,
  sharedDmSourceMessageId,
  usesSharedGroupRouting,
  classifySession,
  isClawTalkSession,
  isSystemRun,
  isSubagentSession,
  normalizeSessionKey,
  extractMessages,
  extractSenderId,
  getMessageIdentity,
  getRawContent,
} from "../helpers.js";
import { subagentParentMap } from "./subagent.js";

type CaptureProvenance = { kind?: string; sourceTool?: string; sourceSessionKey?: string };

type CaptureContext = Parameters<typeof isSystemRun>[0] & {
  agentId?: string;
  sessionId?: string;
  channel?: string;
  messageProvider?: string;
  runId?: string;
  sourceMessageId?: string;
  senderId?: string;
  inputProvenance?: CaptureProvenance;
};

function systemMessageIndexes(messages: unknown[], ctx: CaptureContext): Set<number> {
  const entries = messages.map((message) => {
    const row = message as {
      role?: string;
      provenance?: { kind?: string };
      idempotencyKey?: string;
      __openclaw?: { runId?: string };
    } | null | undefined;
    const userKey = row?.role === "user" && typeof row.idempotencyKey === "string" &&
      row.idempotencyKey.endsWith(":user") ? row.idempotencyKey.slice(0, -5) : undefined;
    return {
      role: row?.role,
      runId: row?.__openclaw?.runId || userKey,
      isSystem: row?.provenance?.kind === "internal_system",
    };
  });
  const systemRuns = new Set<string>();
  const humanRuns = new Set<string>();
  if (ctx.runId) (isSystemRun(ctx) ? systemRuns : humanRuns).add(ctx.runId);
  for (const entry of entries) {
    if (!entry.runId) continue;
    if (entry.isSystem) systemRuns.add(entry.runId);
    else if (entry.role === "user") humanRuns.add(entry.runId);
  }

  const indexes = new Set<number>();
  let systemTurn = false;
  let userRunId: string | undefined;
  for (const [index, entry] of entries.entries()) {
    const isSystem = entry.isSystem || (entry.runId !== undefined && systemRuns.has(entry.runId));
    if (entry.role === "user") {
      systemTurn = isSystem;
      userRunId = entry.runId;
    }
    // Explicit run ownership wins over adjacency for interleaved replies.
    if (isSystem || (systemTurn && (!entry.runId || (!userRunId && !humanRuns.has(entry.runId))))) {
      indexes.add(index);
    }
  }
  return indexes;
}

/**
 * Core message capture logic shared by agent_end, before_compaction, and before_reset.
 * Returns the number of new messages saved (or 0 if none).
 * Exported for testability.
 */
export async function flushMessages(
  api: OpenClawPluginApi,
  state: PluginState,
  messages: unknown[],
  ctx: CaptureContext,
  preservePendingHistory = false,
): Promise<number> {
  if (!messages?.length) return 0;

  const openclawSessionKey = normalizeSessionKey(ctx.sessionKey);
  // OpenClaw appends this suffix to lookup runs. Skip capture even when system runs are enabled.
  if (/(?:^|:)active-memory:[a-f0-9]{12}$/i.test(openclawSessionKey)) return 0;

  const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
  const keyContext = dmHookSessionContext({ ...ctx, agentId }, api.config);
  const dmKey = resolveSharedDmKey(keyContext);
  if (dmKey) {
    messages = selectSharedDmHistory(ctx.sessionKey, dmKey, messages);
    if (!messages.length) return 0;
  } else if (!usesSharedGroupRouting(api.config) && isSharedMainSessionKey(ctx.sessionKey) &&
      hasSharedDmHistory(ctx.sessionKey, messages)) {
    // Reset can expose a mixed transcript with no trusted sender or channel.
    return 0;
  }
  const sessionKey = buildSessionKey(keyContext);
  const isSubagent = isSubagentSession(ctx);
  const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;
  const sessionClass = classifySession(openclawSessionKey);
  const filterSystemRuns = !state.cfg.captureSystemRuns;
  const systemRun = filterSystemRuns && isSystemRun(ctx);
  if (filterSystemRuns && (sessionClass === "cron" || (systemRun && !preservePendingHistory))) {
    return 0;
  }
  const skipped = filterSystemRuns ? systemMessageIndexes(messages, ctx) : undefined;
  if (skipped?.size === messages.length) return 0;

  await state.ensureInitialized();
  const agentPeer = await state.getAgentPeer(agentId);
  const parentPeer =
    isSubagent && parentAgentId && parentAgentId !== agentId
      ? await state.getAgentPeer(parentAgentId)
      : null;

  const sessionMeta: Record<string, unknown> = {
    agentId,
    openclawSessionKey,
    ...(dmKey ? { conversationSessionKey: dmKey } : {}),
    sessionClass,
    ...(typeof ctx.messageProvider === "string" && ctx.messageProvider.length > 0
      ? { messageProvider: ctx.messageProvider }
      : {}),
    ...(typeof ctx.sessionId === "string" && ctx.sessionId.length > 0
      ? { lastSessionId: ctx.sessionId }
      : {}),
    ...(isSubagent ? {
      isSubagent: true,
      ...(parentPeer ? { parentPeerId: parentPeer.id } : {}),
    } : {}),
  };

  // Don't pass metadata: it replaces persisted metadata on existing sessions,
  // wiping lastSavedIndex.
  const session = await state.honcho.session(sessionKey);
  const meta = await session.getMetadata();
  const existingMeta: Record<string, unknown> =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

  // Gateway chat.send uses its run ID as MessageSid and persists the user
  // entry with a run-scoped idempotency key. Prompt rebuilds may already
  // include this entry, and the inbound hook may have run elsewhere.
  // A lifecycle flush can save human history while a system run is active.
  // Its run and source IDs must never be applied to those human rows.
  const runId = systemRun ? undefined : ctx.runId;
  const isClawTalk = isClawTalkSession(openclawSessionKey);
  const clawTalkUserIndex =
    runId && isClawTalk
      ? messages.findIndex((message) => {
          const entry = message as { role?: string; idempotencyKey?: string } | undefined;
          return entry?.role === "user" && entry.idempotencyKey === `${runId}:user`;
        })
      : -1;
  const turnStartIndex =
    clawTalkUserIndex >= 0
      ? clawTalkUserIndex
      : skipped?.size
        ? 0
        : Math.min(Math.max(state.turnStartIndex.get(sessionKey) ?? 0, 0), messages.length);
  const sourceMessageId = clawTalkUserIndex >= 0 ? runId : systemRun || dmKey ? undefined : ctx.sourceMessageId;
  const rawLastSavedIndex =
    typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex : 0;
  const lastSavedIndex = Math.min(Math.max(rawLastSavedIndex, 0), messages.length);
  const checkpoint = existingMeta.lastSavedMessageId;
  if (dmKey && checkpoint === undefined && !state.turnStartIndex.has(sessionKey)) {
    // A new participant session has no boundary for distinguishing prior shared history.
    return 0;
  }
  let startIndex = Math.max(turnStartIndex, lastSavedIndex);
  if (typeof checkpoint === "string" && checkpoint.length > 0) {
    const hintedIndex = lastSavedIndex - 1;
    // Stable keys are unique. For hash matches, use the earliest occurrence
    // because identical message bodies can repeat within a snapshot.
    const anchorIndex = checkpoint.startsWith("k:") &&
      getMessageIdentity(messages[hintedIndex]) === checkpoint
      ? hintedIndex
      : messages.findIndex((message) => getMessageIdentity(message) === checkpoint);
    // An absent anchor may mean a shorter or non-overlapping snapshot. Revisit
    // it rather than treating a stale offset as proof the rows were saved.
    startIndex = Math.max(anchorIndex + 1, clawTalkUserIndex);
  }
  const pending: Array<{ message: unknown; rawIndex: number }> = [];
  let alreadyCaptured = false;
  if (clawTalkUserIndex >= 0 && sourceMessageId && runId) {
    // Snapshot indices can shift between runs. A durable run match also
    // protects retries if the write succeeds before the cursor is saved.
    const existing = await session.messages({
      filters: { metadata: { openclawMessageId: sourceMessageId, openclawRunId: runId } },
      size: 1,
    });
    alreadyCaptured = existing.items.length > 0;
    if (!alreadyCaptured && !skipped?.has(clawTalkUserIndex) && clawTalkUserIndex < startIndex) {
      pending.push({ message: messages[clawTalkUserIndex], rawIndex: clawTalkUserIndex });
    }
  }
  for (let rawIndex = startIndex; rawIndex < messages.length; rawIndex++) {
    if (skipped?.has(rawIndex)) continue;
    if (rawIndex === clawTalkUserIndex && alreadyCaptured) continue;
    pending.push({ message: messages[rawIndex], rawIndex });
  }
  if (pending.length === 0) return 0;
  const clawTalkPeer = clawTalkUserIndex >= 0 && ctx.senderId
    ? await state.getClawTalkParticipantPeer(ctx.senderId)
    : undefined;

  let lastUserOffset = -1;
  let lastAssistantOffset = -1;
  for (let offset = 0; offset < pending.length; offset++) {
    const { message } = pending[offset];
    if (!message || typeof message !== "object") continue;
    const role = (message as Record<string, unknown>).role;
    if (role === "user") lastUserOffset = offset;
    if (role === "assistant") lastAssistantOffset = offset;
  }

  // Pre-resolve participant peers for all unique sender IDs in this batch
  const senderIds = new Set<string>();
  const senderByIndex = new Map<number, string>();
  const sendingAgentByIndex = new Map<number, Awaited<ReturnType<typeof state.getAgentPeer>> | undefined>();
  let lastSenderId = clawTalkPeer ? ctx.senderId : undefined;
  let userMsgCount = 0;
  for (const { message: msg, rawIndex } of pending) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as {
      role?: string;
      idempotencyKey?: string;
      provenance?: CaptureProvenance;
      __openclaw?: { senderId?: unknown; runId?: unknown };
    };
    if (m.role !== "user") continue;
    if (isClawTalk) continue;
    userMsgCount++;
    const rawContent = getRawContent(msg);
    const persistedSenderId = m.__openclaw?.senderId;
    // The hook sender belongs to one run, not to other rows in this snapshot.
    const isCurrentTurn = runId &&
      (m.idempotencyKey === `${runId}:user` || m.__openclaw?.runId === runId);
    const provenance = m.provenance ?? (isCurrentTurn ? ctx.inputProvenance : undefined);
    if (provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send") {
      const sourceAgentId = typeof provenance.sourceSessionKey === "string"
        ? parseAgentSessionKey(provenance.sourceSessionKey)?.agentId
        : undefined;
      // An unresolved handoff must not fall through to a human peer.
      sendingAgentByIndex.set(rawIndex, sourceAgentId ? await state.getAgentPeer(sourceAgentId) : undefined);
      continue;
    }
    const senderId = (isCurrentTurn ? ctx.senderId : undefined) ||
      (typeof persistedSenderId === "string" ? persistedSenderId : undefined) ||
      extractSenderId(rawContent);
    if (senderId) {
      senderByIndex.set(rawIndex, senderId);
      senderIds.add(senderId);
      lastSenderId = senderId;
    } else {
      const hasConvInfo = rawContent.includes("Conversation info (untrusted metadata):");
      api.logger.debug?.(`[honcho] User message without sender_id (hasConvInfo=${hasConvInfo}, contentLen=${rawContent.length})`);
    }
  }
  if (senderIds.size > 0) {
    api.logger.debug?.(`[honcho] Resolved ${senderIds.size} unique sender(s) from ${userMsgCount} user message(s)`);
  }

  // Parallel peer resolution — avoids sequential await bottleneck in group chats.
  const resolvedPeers = new Map<string, Awaited<ReturnType<typeof state.getParticipantPeer>>>();
  const senderIdArray = [...senderIds];
  const peers = await Promise.all(senderIdArray.map((id) => state.getParticipantPeer(id)));
  for (let i = 0; i < senderIdArray.length; i++) {
    resolvedPeers.set(senderIdArray[i], peers[i]);
  }

  const defaultParticipantPeer = clawTalkPeer ?? (isClawTalk ? agentPeer : await state.getParticipantPeer());

  // Build peer configs: default owner + all resolved participant peers + agent + parent
  const peerConfigMap = new Map<string, { observeMe: boolean; observeOthers: boolean }>();
  if (!isClawTalk) {
    peerConfigMap.set(OWNER_ID, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers });
  }
  if (clawTalkPeer) {
    peerConfigMap.set(clawTalkPeer.id, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers });
  }
  for (const [, peer] of resolvedPeers) {
    if (peer.id !== OWNER_ID) {
      peerConfigMap.set(peer.id, { observeMe: true, observeOthers: state.cfg.ownerObserveOthers });
    }
  }
  // Keep owner->owner as canonical user memory. The agent peer still observes
  // its own messages, but must not create a second agent-main->owner model.
  peerConfigMap.set(agentPeer.id, { observeMe: true, observeOthers: false });
  if (parentPeer) {
    peerConfigMap.set(parentPeer.id, { observeMe: false, observeOthers: true });
  }
  for (const peer of sendingAgentByIndex.values()) {
    if (peer) {
      peerConfigMap.set(peer.id, {
        observeMe: true,
        observeOthers: peerConfigMap.get(peer.id)?.observeOthers ?? false,
      });
    }
  }

  const peerConfigs = Array.from(peerConfigMap.entries()) as Array<
    [string, { observeMe: boolean; observeOthers: boolean }]
  >;
  await session.addPeers(peerConfigs);

  // Extract one-by-one to pair each output with its raw index — needed to
  // advance the saved-watermark safely when the batch is chunked below.
  type ExtractedMessage = ReturnType<typeof extractMessages>[number];
  const extracted: Array<{ message: ExtractedMessage; rawIndex: number }> = [];
  for (let offset = 0; offset < pending.length; offset++) {
    const { message: rawMessage, rawIndex } = pending[offset];
    const isSourceUser = clawTalkUserIndex >= 0
      ? rawIndex === clawTalkUserIndex
      : offset === lastUserOffset;
    const isClawTalkUser = isClawTalk && (rawMessage as { role?: unknown } | undefined)?.role === "user";
    if (isClawTalkUser && (rawIndex !== clawTalkUserIndex || !clawTalkPeer)) continue;
    const sendingAgentPeer = sendingAgentByIndex.get(rawIndex);
    if (sendingAgentByIndex.has(rawIndex) && !sendingAgentPeer) continue;
    const senderId = senderByIndex.get(rawIndex);
    const participantPeer = sendingAgentPeer || (senderId && resolvedPeers.get(senderId)) || defaultParticipantPeer;
    const dmMessageId = dmKey ? sharedDmSourceMessageId(rawMessage) : undefined;
    const [message] = extractMessages(
      [rawMessage],
      participantPeer,
      agentPeer,
      state.cfg.noisePatterns,
      undefined,
      isSourceUser && sourceMessageId
        ? {
            openclawMessageId: sourceMessageId,
            ...(runId ? { openclawRunId: runId } : {}),
          }
          : dmMessageId
            ? { openclawMessageId: dmMessageId }
            : offset === lastAssistantOffset && runId
              ? { openclawRunId: runId }
              : undefined,
    );
    if (message) extracted.push({ message, rawIndex });
  }

  // participantSenderId = last active sender, used by tools to resolve the
  // session's current participant peer. Named "sender" (not "peer") to
  // distinguish raw channel IDs from resolved Honcho peer IDs.
  const updatedMeta: Record<string, unknown> = {
    ...existingMeta,
    ...sessionMeta,
  };
  if (lastSenderId) {
    updatedMeta.participantSenderId = lastSenderId;
  }

  const saveCheckpoint = async (index: number) => {
    let lastSavedMessageId: string | undefined;
    for (let rawIndex = index - 1; rawIndex >= 0 && !lastSavedMessageId; rawIndex--) {
      lastSavedMessageId = getMessageIdentity(messages[rawIndex]);
    }
    await session.setMetadata({
      ...updatedMeta,
      lastSavedIndex: index,
      ...(lastSavedMessageId ? { lastSavedMessageId } : {}),
    });
  };

  if (extracted.length === 0) {
    await saveCheckpoint(messages.length);
    state.invalidateSessionParticipantPeer?.(sessionKey);
    return 0;
  }

  // Honcho rejects >100 messages per request (HTTP 422). Advance the watermark
  // per chunk so a mid-batch failure doesn't re-send persisted chunks. Last
  // chunk jumps to messages.length to cover trailing filtered noise messages.
  const addMessagesLimit = 100;
  for (let i = 0; i < extracted.length; i += addMessagesLimit) {
    const chunk = extracted.slice(i, i + addMessagesLimit);
    await session.addMessages(chunk.map((e) => e.message));
    const isLastChunk = i + addMessagesLimit >= extracted.length;
    const lastSavedIndex = isLastChunk
      ? messages.length
      : Math.max(startIndex, chunk[chunk.length - 1].rawIndex + 1);
    await saveCheckpoint(lastSavedIndex);
  }
  state.invalidateSessionParticipantPeer?.(sessionKey);
  return extracted.length;
}

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  const sourceMessageIdsByRun = new Map<string, string>();
  const pendingSourceMessageIdsBySession = new Map<string, string>();
  const flushesBySession = new Map<string, Promise<number>>();
  // Compaction and reset can advance lastSavedIndex before agent_end runs.
  const flushCapturedMessages = (
    messages: unknown[],
    ctx: CaptureContext,
    preservePendingHistory = false,
  ) => {
    const sourceMessageId = ctx.runId ? sourceMessageIdsByRun.get(ctx.runId) : undefined;
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const sessionKey = buildSessionKey(dmHookSessionContext({ ...ctx, agentId }, api.config));
    const previous = flushesBySession.get(sessionKey);
    // Detached agent_end and compaction hooks can overlap on the same cursor.
    const current = Promise.resolve(previous).catch(() => undefined).then(() =>
      flushMessages(api, state, messages, { ...ctx, agentId, sourceMessageId }, preservePendingHistory)
    );
    flushesBySession.set(sessionKey, current);
    return current.finally(() => {
      if (flushesBySession.get(sessionKey) === current) flushesBySession.delete(sessionKey);
    });
  };

  api.on("message_received", (event, ctx) => {
    if (!state.cfg.captureSystemRuns && isSystemRun(ctx)) return;
    const runId = event.runId ?? ctx.runId;
    const messageId = event.messageId ?? ctx.messageId;
    // message_received can predate runId; bind this ID when before_prompt_build supplies it.
    if (runId && messageId) {
      sourceMessageIdsByRun.set(runId, messageId);
      if (ctx.sessionKey) pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
    } else if (messageId && ctx.sessionKey) {
      pendingSourceMessageIdsBySession.set(ctx.sessionKey, messageId);
    }
  });

  api.on("before_prompt_build", (_event, ctx) => {
    if (!state.cfg.captureSystemRuns && isSystemRun(ctx)) return;
    if (!ctx.runId || !ctx.sessionKey) return;
    const messageId = pendingSourceMessageIdsBySession.get(ctx.sessionKey);
    if (!messageId) return;
    pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
    sourceMessageIdsByRun.set(ctx.runId, messageId);
  });

  /**
   * agent_end — primary capture hook. Saves conversation messages after each turn.
   */
  api.on("agent_end", async (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    if (!state.cfg.captureSystemRuns && isSystemRun(ctx)) {
      if (runId) sourceMessageIdsByRun.delete(runId);
      return;
    }
    if (!event.success || !event.messages?.length) {
      if (runId) sourceMessageIdsByRun.delete(runId);
      if (ctx.sessionKey) pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
      return;
    }

    try {
      await flushCapturedMessages(event.messages, { ...ctx, runId });
    } catch (error) {
      api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
      if (error instanceof Error) {
        api.logger.error(`[honcho] Stack: ${error.stack}`);
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
        if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
      }
    } finally {
      if (runId) sourceMessageIdsByRun.delete(runId);
      if (ctx.sessionKey) pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
      const sessionKey = buildSessionKey(
        dmHookSessionContext(ctx, api.config),
        state.resolveDefaultAgentId,
      );
      state.turnStartIndex.delete(sessionKey);
      if (isSubagentSession(ctx)) subagentParentMap.delete(ctx.sessionKey ?? "");
    }
  });

  /**
   * before_compaction — flush unsaved messages before compaction truncates them.
   * OpenClaw fires this before compacting the session transcript. Messages on
   * disk are preserved (via sessionFile), but the in-memory array will be
   * truncated. We save everything we haven't saved yet.
   */
  api.on("before_compaction", async (event, ctx) => {
    if (!event.messages?.length) return;

    try {
      const saved = await flushCapturedMessages(event.messages, ctx, true);
      if (saved > 0) {
        api.logger.debug?.(`[honcho] Flushed ${saved} messages before compaction`);
      }
    } catch (error) {
      api.logger.warn?.(`[honcho] Failed to flush messages before compaction: ${error}`);
    }
  });

  /**
   * before_reset — flush unsaved messages before /new or /reset clears the session.
   * This ensures no conversation data is lost when the user resets.
   */
  api.on("before_reset", async (event, ctx) => {
    try {
      if (event.messages?.length) {
        const saved = await flushCapturedMessages(event.messages, ctx, true);
        if (saved > 0) {
          api.logger.debug?.(`[honcho] Flushed ${saved} messages before session reset`);
        }
      }
    } catch (error) {
      api.logger.warn?.(`[honcho] Failed to flush messages before reset: ${error}`);
    } finally {
      if (ctx.sessionKey) pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
    }
  });
}
