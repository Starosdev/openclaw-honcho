import { Type } from "@sinclair/typebox";
import { isClawTalkSession } from "../helpers.js";
function isDirectOperator(ctx) {
    const channel = ctx.messageChannel?.trim().toLowerCase();
    return ctx.senderIsOwner === true && ctx.conversationReadOrigin === "direct-operator" &&
        !isClawTalkSession(ctx.sessionKey?.toLowerCase()) &&
        channel !== "clawtalk" && channel !== "clawtalk-user" &&
        !/^gateway-device-[a-f0-9]{64}$/i.test(ctx.requesterSenderId?.trim() ?? "");
}
export function registerWorkspaceChatTool(api, state) {
    api.registerTool((ctx) => {
        if (!isDirectOperator(ctx))
            return null;
        return {
            name: "honcho_workspace_chat",
            label: "Ask Honcho Workspace",
            description: "Ask about participants, sessions, and agents across this Honcho workspace.",
            parameters: Type.Object({
                query: Type.String({ minLength: 1, description: "Question about the workspace" }),
                depth: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("thorough")])),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params) {
                if (!isDirectOperator(ctx)) {
                    throw new Error("Honcho workspace chat requires a verified direct operator.");
                }
                const { query, depth = "quick" } = params;
                await state.ensureInitialized();
                const answer = await state.honcho.chat(query, {
                    reasoningLevel: depth === "thorough" ? "high" : "low",
                });
                return {
                    content: [{ type: "text", text: answer ?? "Honcho has no relevant information in this workspace." }],
                    details: { query, depth, answer: answer ?? null },
                };
            },
        };
    }, { name: "honcho_workspace_chat" });
}
