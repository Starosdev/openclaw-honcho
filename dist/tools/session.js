import { Type } from "@sinclair/typebox";
import { buildSessionKey, cleanMessageContent } from "../helpers.js";
export function registerSessionTool(api, state) {
    api.registerTool((toolCtx) => ({
        name: "honcho_session",
        label: "Get Session History",
        description: "Retrieve conversation history and summary from the current session. Supports semantic search within the session. Does not access cross-session memory.",
        parameters: Type.Object({
            includeMessages: Type.Optional(Type.Boolean({
                description: "Include recent message history (default: true)",
            })),
            includeSummary: Type.Optional(Type.Boolean({
                description: "Include summary of earlier conversation (default: true)",
            })),
            searchQuery: Type.Optional(Type.String({
                description: "Semantic search query to find specific topics in the conversation",
            })),
            messageLimit: Type.Optional(Type.Number({
                description: "Approximate token budget for messages (default: 4000)",
                minimum: 100,
                maximum: 32000,
            })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params) {
            const { includeMessages = true, includeSummary = true, searchQuery, messageLimit = 4000, } = params;
            await state.ensureInitialized();
            const agentPeer = await state.getAgentPeer(toolCtx.agentId);
            const sessionKey = buildSessionKey({
                sessionKey: toolCtx.sessionKey,
                agentId: toolCtx.agentId,
            });
            const participantPeer = await state.resolveToolParticipantPeer(toolCtx);
            try {
                const session = await state.honcho.session(sessionKey);
                const isOwner = toolCtx.senderIsOwner === true;
                const context = await session.context({
                    summary: includeSummary && isOwner,
                    tokens: messageLimit,
                    limitToSession: true,
                    peerTarget: participantPeer,
                    peerPerspective: agentPeer,
                    representationOptions: searchQuery ? { searchQuery } : undefined,
                });
                const sections = [];
                const summary = isOwner && includeSummary ? context.summary?.content || null : null;
                const peerCard = context.peerCard ?? [];
                const representation = context.peerRepresentation || null;
                if (summary) {
                    sections.push(`## Earlier Conversation Summary\n\n${summary}`);
                }
                if (peerCard.length) {
                    sections.push(`## User Profile\n\n${peerCard.map((f) => `• ${f}`).join("\n")}`);
                }
                if (representation) {
                    sections.push(`## User Context\n\n${representation}`);
                }
                const messages = includeMessages
                    ? context.messages
                        .filter((msg) => isOwner || msg.peerId === participantPeer.id)
                        .map((msg) => ({
                        speaker: state.isParticipantPeerId(msg.peerId) ? "User" : "OpenClaw",
                        createdAt: msg.createdAt ?? null,
                        content: cleanMessageContent(msg.content),
                    }))
                    : [];
                if (messages.length > 0) {
                    const messageLines = messages.map((msg) => {
                        const timestamp = msg.createdAt
                            ? new Date(msg.createdAt).toLocaleString()
                            : "";
                        return `**${msg.speaker}**${timestamp ? ` (${timestamp})` : ""}:\n${msg.content}`;
                    });
                    sections.push(`## Recent Messages (${messages.length})\n\n${messageLines.join("\n\n---\n\n")}`);
                }
                const searchNote = searchQuery
                    ? `\n\n*Results filtered by search: "${searchQuery}"*`
                    : "";
                return {
                    content: [
                        {
                            type: "text",
                            text: sections.length
                                ? sections.join("\n\n---\n\n") + searchNote
                                : "No conversation history available for this session yet.",
                        },
                    ],
                    details: {
                        messageCount: messages.length,
                        hasSummary: summary !== null,
                        sessionKey,
                        summary,
                        peerCard,
                        representation,
                        messages,
                    },
                };
            }
            catch (error) {
                const isNotFound = error instanceof Error &&
                    (error.name === "NotFoundError" ||
                        error.message.toLowerCase().includes("not found"));
                if (isNotFound) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "No conversation history found. This appears to be a new session.",
                            },
                        ],
                        details: {
                            messageCount: 0,
                            hasSummary: false,
                            sessionKey,
                            summary: null,
                            peerCard: [],
                            representation: null,
                            messages: [],
                        },
                    };
                }
                throw error;
            }
        },
    }), { name: "honcho_session" });
}
