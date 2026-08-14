/**
 * Pure helper functions — no mutable state dependencies.
 */
import type { Peer, MessageInput } from "@honcho-ai/sdk";
export type SessionClass = "chat" | "cron" | "subagent" | "thread" | "unknown";
/**
 * Extract plain text from a message's `content` (string or array of content blocks).
 * Returns "" for non-message inputs or messages with no text blocks.
 */
export declare function getRawContent(msg: unknown): string;
export declare function normalizeSessionKey(raw?: string): string;
/**
 * Classify a normalized OpenClaw sessionKey into one of the persistence
 * categories tracked in Honcho session metadata. Cron and subagent
 * detection delegate to upstream OpenClaw helpers so plugin classification
 * cannot drift from the routing-key DSL.
 */
export declare function classifySession(sessionKey: string): SessionClass;
/**
 * Extract the channel/provider segment from a canonical OpenClaw sessionKey
 * (`agent:<agentId>:<provider>:...`). Returns null when the key does not match
 * that shape — the caller then elides the provider segment from the id.
 *
 * Note: this is sourced from the same string that feeds the hash, so it cannot
 * disagree with the hash. `ctx.messageProvider` is deliberately not consulted.
 */
export declare function extractProvider(sessionKey: string): string | null;
/**
 * Build a Honcho session id of the form
 * `<sessionClass>-[<provider>-]<agentId>-<24 hex>`.
 *
 * The id is decoupled from OpenClaw's routing-key DSL: prefix segments are
 * derived from the same inputs as the hash, so they cannot drift independently.
 * `ctx.messageProvider` is intentionally not an input — that field is unstable
 * (missing → "unknown") and lives in session metadata instead.
 *
 * When `ctx.agentId` is undefined, callers should pass `resolveDefaultAgentId`
 * (typically `state.resolveDefaultAgentId`) so the id matches the agent id used
 * by `flushMessages` / `before_prompt_build`. Without a resolver we fall back
 * to "main", which only matches workspaces with no configured default agent.
 */
export declare function buildSessionKey(ctx?: {
    sessionKey?: string;
    agentId?: string;
}, resolveDefaultAgentId?: () => string): string;
export declare function isSubagentSession(ctx?: {
    sessionKey?: string;
}): boolean;
/**
 * Strip Honcho's own injected context from message content to prevent
 * feedback loops (context injected -> saved -> re-injected -> grows forever).
 * Also strips OpenClaw's inbound metadata blocks (Conversation info, Sender,
 * Thread starter, etc.) which are AI-facing only and must not be stored in
 * Honcho as user message content.
 * Also strips leading OpenClaw reply directive tags (e.g. [[reply_to_current]])
 * so control tokens are never persisted or re-surfaced as user-visible text.
 */
export declare function cleanMessageContent(content: string): string;
/**
 * Extract the sender_id from a raw message's "Conversation info (untrusted metadata):"
 * metadata block. Must be called BEFORE cleanMessageContent() which strips these blocks.
 * Returns undefined for DMs (no metadata block) or on parse failure.
 *
 * Only considers the FIRST occurrence of the sentinel to prevent user-pasted or quoted
 * metadata blocks from poisoning sender attribution.
 */
export declare function extractSenderId(content: string): string | undefined;
/**
 * Returns true if the message should be dropped entirely.
 * Patterns starting with "/" are treated as anchored regexes (e.g. "/^HEARTBEAT/i").
 * All other patterns match by exact equality or prefix (startsWith).
 */
export declare function shouldSkipMessage(content: string, noisePatterns: string[]): boolean;
export declare function extractMessages(rawMessages: unknown[], defaultParticipantPeer: Peer, agentPeer: Peer, noisePatterns?: string[], resolvePeer?: (senderId: string) => Peer | undefined): MessageInput[];
