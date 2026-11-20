import { OWNER_ID } from "../state.js";
import { buildSessionKey, classifySession, isClawTalkSession, isSubagentSession, normalizeSessionKey, extractMessages, extractSenderId, getRawContent, } from "../helpers.js";
import { subagentParentMap } from "./subagent.js";
/**
 * Core message capture logic shared by agent_end, before_compaction, and before_reset.
 * Returns the number of new messages saved (or 0 if none).
 * Exported for testability.
 */
export async function flushMessages(api, state, messages, ctx) {
    if (!messages?.length)
        return 0;
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
    const isSubagent = isSubagentSession(ctx);
    const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;
    const openclawSessionKey = normalizeSessionKey(ctx.sessionKey);
    const sessionClass = classifySession(openclawSessionKey);
    await state.ensureInitialized();
    const agentPeer = await state.getAgentPeer(agentId);
    const parentPeer = isSubagent && parentAgentId && parentAgentId !== agentId
        ? await state.getAgentPeer(parentAgentId)
        : null;
    const sessionMeta = {
        agentId,
        openclawSessionKey,
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
    const existingMeta = meta && typeof meta === "object" ? meta : {};
    // Gateway chat.send uses its run ID as MessageSid and persists the user
    // entry with a run-scoped idempotency key. Prompt rebuilds may already
    // include this entry, and the inbound hook may have run elsewhere.
    const runId = ctx.runId;
    const isClawTalk = isClawTalkSession(openclawSessionKey);
    const clawTalkUserIndex = runId && isClawTalk
        ? messages.findIndex((message) => {
            const entry = message;
            return entry?.role === "user" && entry.idempotencyKey === `${runId}:user`;
        })
        : -1;
    const turnStartIndex = clawTalkUserIndex >= 0
        ? clawTalkUserIndex
        : Math.min(Math.max(state.turnStartIndex.get(sessionKey) ?? 0, 0), messages.length);
    const sourceMessageId = clawTalkUserIndex >= 0 ? runId : ctx.sourceMessageId;
    const rawLastSavedIndex = typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex : 0;
    const lastSavedIndex = Math.min(Math.max(rawLastSavedIndex, 0), messages.length);
    const startIndex = Math.max(turnStartIndex, lastSavedIndex);
    const pending = [];
    let alreadyCaptured = false;
    if (clawTalkUserIndex >= 0 && sourceMessageId && runId) {
        // Snapshot indices can shift between runs. A durable run match also
        // protects retries if the write succeeds before the cursor is saved.
        const existing = await session.messages({
            filters: { metadata: { openclawMessageId: sourceMessageId, openclawRunId: runId } },
            size: 1,
        });
        alreadyCaptured = existing.items.length > 0;
        if (!alreadyCaptured && clawTalkUserIndex < startIndex) {
            pending.push({ message: messages[clawTalkUserIndex], rawIndex: clawTalkUserIndex });
        }
    }
    for (let rawIndex = startIndex; rawIndex < messages.length; rawIndex++) {
        if (rawIndex === clawTalkUserIndex && alreadyCaptured)
            continue;
        pending.push({ message: messages[rawIndex], rawIndex });
    }
    if (pending.length === 0)
        return 0;
    const clawTalkPeer = clawTalkUserIndex >= 0 && ctx.senderId
        ? await state.getClawTalkParticipantPeer(ctx.senderId)
        : undefined;
    let lastUserOffset = -1;
    let lastAssistantOffset = -1;
    for (let offset = 0; offset < pending.length; offset++) {
        const { message } = pending[offset];
        if (!message || typeof message !== "object")
            continue;
        const role = message.role;
        if (role === "user")
            lastUserOffset = offset;
        if (role === "assistant")
            lastAssistantOffset = offset;
    }
    // Pre-resolve participant peers for all unique sender IDs in this batch
    const senderIds = new Set();
    let lastSenderId = clawTalkPeer ? ctx.senderId : undefined;
    let userMsgCount = 0;
    for (const { message: msg } of pending) {
        if (!msg || typeof msg !== "object")
            continue;
        const m = msg;
        if (m.role !== "user")
            continue;
        if (isClawTalk)
            continue;
        userMsgCount++;
        const rawContent = getRawContent(msg);
        const senderId = extractSenderId(rawContent);
        if (senderId) {
            senderIds.add(senderId);
            lastSenderId = senderId;
        }
        else {
            const hasConvInfo = rawContent.includes("Conversation info (untrusted metadata):");
            api.logger.debug?.(`[honcho] User message without sender_id (hasConvInfo=${hasConvInfo}, contentLen=${rawContent.length})`);
        }
    }
    if (senderIds.size > 0) {
        api.logger.debug?.(`[honcho] Resolved ${senderIds.size} unique sender(s) from ${userMsgCount} user message(s)`);
    }
    // Parallel peer resolution — avoids sequential await bottleneck in group chats.
    const resolvedPeers = new Map();
    const senderIdArray = [...senderIds];
    const peers = await Promise.all(senderIdArray.map((id) => state.getParticipantPeer(id)));
    for (let i = 0; i < senderIdArray.length; i++) {
        resolvedPeers.set(senderIdArray[i], peers[i]);
    }
    const defaultParticipantPeer = clawTalkPeer ?? (isClawTalk ? agentPeer : await state.getParticipantPeer());
    // Build peer configs: default owner + all resolved participant peers + agent + parent
    const peerConfigMap = new Map();
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
    const peerConfigs = Array.from(peerConfigMap.entries());
    await session.addPeers(peerConfigs);
    const extracted = [];
    for (let offset = 0; offset < pending.length; offset++) {
        const { message: rawMessage, rawIndex } = pending[offset];
        const isSourceUser = clawTalkUserIndex >= 0
            ? rawIndex === clawTalkUserIndex
            : offset === lastUserOffset;
        const isClawTalkUser = isClawTalk && rawMessage?.role === "user";
        if (isClawTalkUser && (rawIndex !== clawTalkUserIndex || !clawTalkPeer))
            continue;
        const [message] = extractMessages([rawMessage], defaultParticipantPeer, agentPeer, state.cfg.noisePatterns, (senderId) => isClawTalkUser ? undefined : resolvedPeers.get(senderId), isSourceUser && sourceMessageId
            ? {
                openclawMessageId: sourceMessageId,
                ...(ctx.runId ? { openclawRunId: ctx.runId } : {}),
            }
            : offset === lastAssistantOffset && ctx.runId
                ? { openclawRunId: ctx.runId }
                : undefined);
        if (message)
            extracted.push({ message, rawIndex });
    }
    // participantSenderId = last active sender, used by tools to resolve the
    // session's current participant peer. Named "sender" (not "peer") to
    // distinguish raw channel IDs from resolved Honcho peer IDs.
    const updatedMeta = {
        ...existingMeta,
        ...sessionMeta,
        lastSavedIndex: messages.length,
    };
    if (lastSenderId) {
        updatedMeta.participantSenderId = lastSenderId;
    }
    if (extracted.length === 0) {
        await session.setMetadata(updatedMeta);
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
        await session.setMetadata({ ...updatedMeta, lastSavedIndex });
    }
    state.invalidateSessionParticipantPeer?.(sessionKey);
    return extracted.length;
}
export function registerCaptureHook(api, state) {
    const sourceMessageIdsByRun = new Map();
    const pendingSourceMessageIdsBySession = new Map();
    const flushesBySession = new Map();
    // Compaction and reset can advance lastSavedIndex before agent_end runs.
    const flushCapturedMessages = (messages, ctx) => {
        const sourceMessageId = ctx.runId ? sourceMessageIdsByRun.get(ctx.runId) : undefined;
        const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
        const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
        const previous = flushesBySession.get(sessionKey);
        // Detached agent_end and compaction hooks can overlap on the same cursor.
        const current = Promise.resolve(previous).catch(() => undefined).then(() => flushMessages(api, state, messages, { ...ctx, agentId, sourceMessageId }));
        flushesBySession.set(sessionKey, current);
        return current.finally(() => {
            if (flushesBySession.get(sessionKey) === current)
                flushesBySession.delete(sessionKey);
        });
    };
    api.on("message_received", (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        const messageId = event.messageId ?? ctx.messageId;
        // message_received can predate runId; bind this ID when before_prompt_build supplies it.
        if (runId && messageId) {
            sourceMessageIdsByRun.set(runId, messageId);
            if (ctx.sessionKey)
                pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
        }
        else if (messageId && ctx.sessionKey) {
            pendingSourceMessageIdsBySession.set(ctx.sessionKey, messageId);
        }
    });
    api.on("before_prompt_build", (_event, ctx) => {
        if (!ctx.runId || !ctx.sessionKey)
            return;
        const messageId = pendingSourceMessageIdsBySession.get(ctx.sessionKey);
        if (!messageId)
            return;
        pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
        sourceMessageIdsByRun.set(ctx.runId, messageId);
    });
    /**
     * agent_end — primary capture hook. Saves conversation messages after each turn.
     */
    api.on("agent_end", async (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!event.success || !event.messages?.length) {
            if (runId)
                sourceMessageIdsByRun.delete(runId);
            if (ctx.sessionKey)
                pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
            return;
        }
        try {
            await flushCapturedMessages(event.messages, { ...ctx, runId });
        }
        catch (error) {
            api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
            if (error instanceof Error) {
                api.logger.error(`[honcho] Stack: ${error.stack}`);
                const anyError = error;
                if (anyError.status)
                    api.logger.error(`[honcho] Status: ${anyError.status}`);
                if (anyError.body)
                    api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
            }
        }
        finally {
            if (runId)
                sourceMessageIdsByRun.delete(runId);
            if (ctx.sessionKey)
                pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
            const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId: ctx.agentId }, state.resolveDefaultAgentId);
            state.turnStartIndex.delete(sessionKey);
            if (isSubagentSession(ctx))
                subagentParentMap.delete(ctx.sessionKey ?? "");
        }
    });
    /**
     * before_compaction — flush unsaved messages before compaction truncates them.
     * OpenClaw fires this before compacting the session transcript. Messages on
     * disk are preserved (via sessionFile), but the in-memory array will be
     * truncated. We save everything we haven't saved yet.
     */
    api.on("before_compaction", async (event, ctx) => {
        if (!event.messages?.length)
            return;
        try {
            const saved = await flushCapturedMessages(event.messages, ctx);
            if (saved > 0) {
                api.logger.debug?.(`[honcho] Flushed ${saved} messages before compaction`);
            }
        }
        catch (error) {
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
                const saved = await flushCapturedMessages(event.messages, ctx);
                if (saved > 0) {
                    api.logger.debug?.(`[honcho] Flushed ${saved} messages before session reset`);
                }
            }
        }
        catch (error) {
            api.logger.warn?.(`[honcho] Failed to flush messages before reset: ${error}`);
        }
        finally {
            if (ctx.sessionKey)
                pendingSourceMessageIdsBySession.delete(ctx.sessionKey);
        }
    });
}
