/**
 * Pure helper functions — no mutable state dependencies.
 */
import type { Peer, MessageInput } from "@honcho-ai/sdk";
import type { RecallScope } from "./config.js";
export type SessionClass = "chat" | "cron" | "subagent" | "thread" | "unknown";
/**
 * Extract plain text from a message's `content` (string or array of content blocks).
 * Returns "" for non-message inputs or messages with no text blocks.
 */
export declare function getRawContent(msg: unknown): string;
export declare function getMessageIdentity(msg: unknown): string | undefined;
export declare function normalizeSessionKey(raw?: string): string;
export declare function isClawTalkSession(sessionKey?: string): boolean;
/**
 * Classify a normalized OpenClaw sessionKey into one of the persistence
 * categories tracked in Honcho session metadata. Cron and subagent
 * detection delegate to upstream OpenClaw helpers so plugin classification
 * cannot drift from the routing-key DSL.
 */
export declare function classifySession(sessionKey: string): SessionClass;
export declare function isSystemRun(ctx: {
    sessionKey?: string;
    trigger?: string;
    inputProvenance?: {
        kind?: string;
    };
}): boolean;
/**
 * Extract the channel/provider segment from a canonical OpenClaw sessionKey
 * (`agent:<agentId>:<provider>:...`). Returns null when the key does not match
 * that shape — the caller then elides the provider segment from the id.
 *
 * Note: this is sourced from the same string that feeds the hash, so it cannot
 * disagree with the hash. `ctx.messageProvider` is deliberately not consulted.
 */
export declare function extractProvider(sessionKey: string): string | null;
type HonchoSessionContext = {
    sessionKey?: string;
    agentId?: string;
    channel?: string;
    messageProvider?: string;
    senderId?: string;
};
export declare function isSharedMainSessionKey(sessionKey?: string): boolean;
/** Match the per-channel-peer key for the external DM channels used by Vega. */
export declare function resolveSharedDmKey(ctx?: HonchoSessionContext): string | undefined;
export declare function toolSessionKeyContext(ctx: {
    sessionKey?: string;
    agentId?: string;
    messageChannel?: string;
    requesterSenderId?: string;
    config?: {
        session?: object;
    };
}, agentId?: string): HonchoSessionContext;
export declare function usesSharedGroupRouting(config?: {
    session?: object;
}): boolean;
export declare function dmHookSessionContext(ctx: HonchoSessionContext, config?: {
    session?: object;
}): HonchoSessionContext;
export declare function sharedDmSourceMessageId(message: unknown): string | undefined;
export declare function hasSharedDmHistory(sessionKey: string | undefined, messages: unknown[]): boolean;
/** Project shared history before using per-participant offsets and checkpoints. */
export declare function selectSharedDmHistory(sessionKey: string | undefined, dmKey: string, messages: unknown[]): unknown[];
/**
 * Build a Honcho session id of the form
 * `<sessionClass>-[<provider>-]<agentId>-<24 hex>`.
 *
 * The id is decoupled from OpenClaw's routing-key DSL: prefix segments are
 * derived from the same inputs as the hash, so they cannot drift independently.
 * Routed keys are authoritative. Shared main DMs use trusted channel/sender
 * metadata to derive the equivalent per-channel-peer key.
 *
 * When `ctx.agentId` is undefined, callers should pass `resolveDefaultAgentId`
 * (typically `state.resolveDefaultAgentId`) so the id matches the agent id used
 * by `flushMessages` / `before_prompt_build`. Without a resolver we fall back
 * to "main", which only matches workspaces with no configured default agent.
 */
export declare function buildSessionKey(ctx?: HonchoSessionContext, resolveDefaultAgentId?: () => string): string;
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
 * Recall options for `session.context()`.
 *
 * `scope` is mutually exclusive with `peerPerspective` and requires
 * `peerTarget`, so callers must drop the perspective peer when a scope is
 * returned — the scope peer becomes the observer instead.
 */
export declare function sessionRecallOptions(scope: RecallScope, scopeName?: string): {
    limitToSession?: boolean;
    scope?: string;
};
/** Recall options for `peer.chat()` and `peer.representation()`. */
export declare function peerRecallOptions(scope: RecallScope, scopeName: string | undefined, sessionId: string): {
    session?: string;
    scope?: string;
};
/**
 * Returns true if the message should be dropped entirely.
 * Patterns starting with "/" are treated as anchored regexes (e.g. "/^HEARTBEAT/i").
 * All other patterns match by exact equality or prefix (startsWith).
 */
export declare function shouldSkipMessage(content: string, noisePatterns: string[]): boolean;
export declare function extractMessages(rawMessages: unknown[], defaultParticipantPeer: Peer, agentPeer: Peer, noisePatterns?: string[], resolvePeer?: (senderId: string) => Peer | undefined, messageMetadata?: Record<string, unknown>): MessageInput[];
export {};
