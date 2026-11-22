import { Type } from "@sinclair/typebox";
import { buildSessionKey, peerRecallOptions } from "../helpers.js";
export function registerAskTool(api, state) {
    api.registerTool((toolCtx) => ({
        name: "honcho_ask",
        label: "Ask Honcho",
        description: "Ask Honcho a question about the user and get a direct answer. Use 'quick' depth for simple factual lookups, 'thorough' for questions requiring synthesis across multiple interactions.",
        parameters: Type.Object({
            query: Type.String({
                description: "Question about the user (e.g., 'What's their name?', 'Describe their communication style')",
            }),
            depth: Type.Optional(Type.Unsafe({
                type: "string",
                enum: ["quick", "thorough"],
                description: "Reasoning depth: 'quick' for simple facts (default), 'thorough' for synthesis and analysis.",
            })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params) {
            const { query, depth = "quick" } = params;
            await state.ensureInitialized();
            const agentId = toolCtx.agentId ?? state.resolveDefaultAgentId();
            const agentPeer = await state.getAgentPeer(agentId);
            const sessionKey = buildSessionKey({ sessionKey: toolCtx.sessionKey, agentId });
            const participantPeer = await state.resolveToolParticipantPeer(toolCtx);
            const reasoningLevel = depth === "thorough" ? "high" : "low";
            // The model decides when to call this, not a person, so it follows the
            // `ask` boundary rather than the explicit-tool one.
            const answer = await agentPeer.chat(query, {
                target: participantPeer,
                reasoningLevel,
                ...peerRecallOptions(state.cfg.recall.ask, state.cfg.recall.scopeName, sessionKey),
            });
            return {
                content: [{ type: "text", text: answer }],
                details: { query, depth, answer: answer ?? null },
            };
        },
    }), { name: "honcho_ask" });
}
