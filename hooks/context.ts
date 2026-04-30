// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey, extractSenderId, isSubagentSession } from "../helpers.js";

export function registerContextHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("before_prompt_build", async (event, ctx) => {
    if (!event.prompt || event.prompt.length < 5) return;

    const t0 = Date.now();
    const sessionKey = buildSessionKey(ctx);
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const isSubagent = isSubagentSession(ctx);
    api.logger.debug?.(`[honcho] before_prompt_build: sessionKey=${sessionKey} agentId=${agentId} isSubagent=${isSubagent}`);

    state.turnStartIndex.set(sessionKey, event.messages.length);

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      const currentSenderId = extractSenderId(event.prompt);
      const participantPeer = currentSenderId
        ? await state.getParticipantPeer(currentSenderId)
        : await state.resolveSessionParticipantPeer(sessionKey);
      api.logger.debug?.(`[honcho] before_prompt_build: peers resolved in ${Date.now() - t0}ms agentPeer=${agentPeer.id} participantPeer=${participantPeer.id}`);

      const sections: string[] = [];

      if (isSubagent) {
        try {
          api.logger.debug?.(`[honcho] before_prompt_build: calling agentPeer.context() (subagent)`);
          const tCtx = Date.now();
          const peerCtx = await agentPeer.context({ target: participantPeer });
          api.logger.debug?.(`[honcho] before_prompt_build: agentPeer.context() completed in ${Date.now() - tCtx}ms`);
          if (peerCtx.peerCard?.length) {
            sections.push(`Key facts:\n${peerCtx.peerCard.map((f: string) => `• ${f}`).join("\n")}`);
          }
          if (peerCtx.representation) {
            sections.push(`User context:\n${peerCtx.representation}`);
          }
        } catch (e: unknown) {
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (isNotFound) return;
          throw e;
        }
      } else {
        const session = await state.honcho.session(sessionKey, { metadata: { agentId } });

        let context;
        try {
          api.logger.debug?.(`[honcho] before_prompt_build: calling session.context() sessionKey=${sessionKey}`);
          const tCtx2 = Date.now();
          context = await session.context({
            summary: true,
            tokens: 2000,
            peerTarget: participantPeer,
            peerPerspective: agentPeer,
          });
          api.logger.debug?.(`[honcho] before_prompt_build: session.context() completed in ${Date.now() - tCtx2}ms (total ${Date.now() - t0}ms)`);
        } catch (e: unknown) {
          const isNotFound =
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
          if (isNotFound) return;
          throw e;
        }

        if (context.peerCard?.length) {
          sections.push(`Key facts:\n${context.peerCard.map((f) => `• ${f}`).join("\n")}`);
        }
        if (context.peerRepresentation) {
          sections.push(`User context:\n${context.peerRepresentation}`);
        }
        if (context.summary?.content) {
          sections.push(`Earlier in this conversation:\n${context.summary.content}`);
        }
      }

      if (sections.length === 0) return;

      const formatted = sections.join("\n\n");

      // Use appendSystemContext instead of systemPrompt to avoid overriding
      // other plugins' prompt contributions. appendSystemContext is appended
      // to the system prompt and benefits from provider prompt caching.
      api.logger.debug?.(`[honcho] before_prompt_build: completed in ${Date.now() - t0}ms sections=${sections.length}`);
      return {
        appendSystemContext: `## User Memory Context\n\n${formatted}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`,
      };
    } catch (error) {
      api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
      return;
    }
  });
}
