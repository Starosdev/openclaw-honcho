import { buildSessionKey, extractSenderId, isClawTalkSession, isSystemRun, isSubagentSession, peerRecallOptions, sessionRecallOptions, } from "../helpers.js";
import { buildDegradedContext, isConnectionFailure } from "../degraded.js";
export function registerContextHook(api, state) {
    api.on("before_prompt_build", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5)
            return;
        if (!state.cfg.captureSystemRuns && isSystemRun(ctx))
            return;
        const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
        const sessionKey = buildSessionKey({ sessionKey: ctx.sessionKey, agentId });
        state.turnStartIndex.set(sessionKey, event.messages.length);
        const isClawTalk = isClawTalkSession(ctx.sessionKey);
        if (isClawTalk && !ctx.senderId)
            return;
        try {
            await state.ensureInitialized();
            const agentPeer = await state.getAgentPeer(agentId);
            // Capture has not run yet, so session metadata can name the prior speaker.
            // Use prompt metadata only for hosts that omit the per-turn sender.
            const currentSenderId = isClawTalk ? ctx.senderId : ctx.senderId || extractSenderId(event.prompt);
            const participantPeer = isClawTalk
                ? await state.getClawTalkParticipantPeer(currentSenderId)
                : currentSenderId
                    ? await state.getParticipantPeer(currentSenderId)
                    : await state.resolveSessionParticipantPeer(sessionKey);
            const sections = [];
            const { automatic, scopeName } = state.cfg.recall;
            let card;
            let representation;
            let summary;
            try {
                if (isSubagentSession(ctx)) {
                    // Capture owns subagent sessions. Peer context includes an unscoped
                    // card, so use representation alone when configured to narrow recall.
                    if (automatic === "workspace") {
                        const context = await agentPeer.context({ target: participantPeer });
                        card = context.peerCard;
                        representation = context.representation;
                    }
                    else {
                        representation = await agentPeer.representation({
                            target: participantPeer,
                            ...peerRecallOptions(automatic, scopeName, sessionKey),
                        });
                    }
                }
                else {
                    // Honcho replaces session metadata when supplied here. Capture owns
                    // its persisted watermark and session provenance.
                    const session = await state.honcho.session(sessionKey);
                    const recall = sessionRecallOptions(automatic, scopeName);
                    const context = await session.context({
                        summary: !isClawTalk,
                        tokens: 2000,
                        peerTarget: participantPeer,
                        // A scope replaces the perspective peer as the observer.
                        ...(recall.scope ? {} : { peerPerspective: agentPeer }),
                        ...recall,
                    });
                    // Older Honcho servers can return a workspace card in session mode.
                    card = recall.limitToSession ? undefined : context.peerCard;
                    representation = context.peerRepresentation;
                    if (!isClawTalk)
                        summary = context.summary?.content;
                }
            }
            catch (e) {
                const isNotFound = e instanceof Error &&
                    (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"));
                if (isNotFound)
                    return;
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
            if (sections.length === 0)
                return;
            const formatted = sections.join("\n\n");
            // Use appendSystemContext instead of systemPrompt to avoid overriding
            // other plugins' prompt contributions. appendSystemContext is appended
            // to the system prompt and benefits from provider prompt caching.
            return {
                appendSystemContext: `## User Memory Context\n\n${formatted}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`,
            };
        }
        catch (error) {
            api.logger.warn?.(`Failed to fetch Honcho context: ${error}`);
            // Only when Honcho could not be reached at all. A rejected request means
            // Honcho answered, and substituting local episodes there would hide the
            // defect behind context that looks fine.
            if (isClawTalk || state.cfg.recall.automatic !== "workspace" || !isConnectionFailure(error))
                return;
            const degraded = await buildDegradedContext(state.cfg.degradedFallback);
            if (!degraded)
                return;
            api.logger.warn?.("Honcho unreachable; serving local Wonder episodes as degraded context");
            return { appendSystemContext: degraded };
        }
    });
}
