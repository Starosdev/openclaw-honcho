// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import {
  buildSessionKey,
  extractSenderId,
  isSubagentSession,
  peerRecallOptions,
  sessionRecallOptions,
} from "../helpers.js";
import { buildDegradedContext, isConnectionFailure } from "../degraded.js";

export function registerContextHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("before_prompt_build", async (event, ctx) => {
    if (!event.prompt || event.prompt.length < 5) return;

    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });

    state.turnStartIndex.set(sessionKey, event.messages.length);

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      // Prefer the sender of the current inbound message — capture has not
      // run yet for this turn, so session metadata still reflects the previous
      // speaker. In group chats this would otherwise build context against the
      // prior participant's representation whenever the speaker changes.
      const currentSenderId = extractSenderId(event.prompt);
      const participantPeer = currentSenderId
        ? await state.getParticipantPeer(currentSenderId)
        : await state.resolveSessionParticipantPeer(sessionKey);

      const sections: string[] = [];

      const { automatic, scopeName } = state.cfg.recall;
      let card: string[] | undefined;
      let representation: string | undefined;
      let summary: string | undefined;
      try {
        if (isSubagentSession(ctx)) {
          // Capture owns subagent sessions. Peer context includes an unscoped
          // card, so use representation alone when configured to narrow recall.
          if (automatic === "workspace") {
            const context = await agentPeer.context({ target: participantPeer });
            card = context.peerCard;
            representation = context.representation;
          } else {
            representation = await agentPeer.representation({
              target: participantPeer,
              ...peerRecallOptions(automatic, scopeName, sessionKey),
            });
          }
        } else {
          // Honcho replaces session metadata when supplied here. Capture owns
          // its persisted watermark and session provenance.
          const session = await state.honcho.session(sessionKey);
          const recall = sessionRecallOptions(automatic, scopeName);
          const context = await session.context({
            summary: true,
            tokens: 2000,
            peerTarget: participantPeer,
            // A scope replaces the perspective peer as the observer.
            ...(recall.scope ? {} : { peerPerspective: agentPeer }),
            ...recall,
          });
          card = context.peerCard;
          representation = context.peerRepresentation;
          summary = context.summary?.content;
        }
      } catch (e: unknown) {
        const isNotFound =
          e instanceof Error &&
          (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
        if (isNotFound) return;
        throw e;
      }

      if (card?.length) {
        sections.push(`Key facts:\n${card.map((f) => `• ${f}`).join("\n")}`);
      }
      if (representation) {
        sections.push(`User context:\n${representation}`);
      }
      if (summary) {
        sections.push(`Earlier in this conversation:\n${summary}`);
      }

      if (sections.length === 0) return;

      const formatted = sections.join("\n\n");

      // Use appendSystemContext instead of systemPrompt to avoid overriding
      // other plugins' prompt contributions. appendSystemContext is appended
      // to the system prompt and benefits from provider prompt caching.
      return {
        appendSystemContext: `## User Memory Context\n\n${formatted}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`,
      };
    } catch (error) {
      api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
      // Only when Honcho could not be reached at all. A rejected request means
      // Honcho answered, and substituting local episodes there would hide the
      // defect behind context that looks fine.
      if (state.cfg.recall.automatic !== "workspace" || !isConnectionFailure(error)) return;
      const degraded = await buildDegradedContext(state.cfg.degradedFallback);
      if (!degraded) return;
      api.logger.warn?.("Honcho unreachable; serving local Wonder episodes as degraded context");
      return { appendSystemContext: degraded };
    }
  });
}
