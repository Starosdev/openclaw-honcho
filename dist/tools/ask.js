import { Type } from "@sinclair/typebox";
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
            const agentPeer = await state.getAgentPeer(toolCtx.agentId);
            const participantPeer = await state.resolveToolParticipantPeer(toolCtx);
            const reasoningLevel = depth === "thorough" ? "high" : "low";
            const answer = await agentPeer.chat(query, {
                target: participantPeer,
                reasoningLevel,
            });
            return {
                content: [{ type: "text", text: answer }],
                details: { query, depth },
            };
        },
    }), { name: "honcho_ask" });
}
