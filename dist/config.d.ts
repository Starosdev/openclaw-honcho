/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */
import { type AntiHitsConfig } from "./antihits.js";
import type { DegradedFallbackConfig } from "./degraded.js";
export declare const DEFAULT_NOISE_PATTERNS: string[];
export declare const DEFAULT_MEMORY_PROCESS_FILE = "/opt/openclaw/vega-data/vega-memory-process.json";
export declare const DEFAULT_OWNER_PEER_ID = "owner";
/**
 * How far a recall call may reach.
 *
 * - `session`   — this Honcho session only.
 * - `scope`     — the sessions in `recall.scopeName`, a Honcho scope. Needs a
 *                 workspace-level API key. A scope with no member sessions
 *                 returns nothing rather than widening. Not to be confused with
 *                 a missing or blank `scopeName`, which falls back to `session`
 *                 below.
 * - `workspace` — every session the peer has written to.
 */
export declare const RECALL_SCOPES: readonly ["session", "scope", "workspace"];
export type RecallScope = (typeof RECALL_SCOPES)[number];
/**
 * Recall boundaries, set per path.
 *
 * All three default to `workspace`, which is Honcho's design: a workspace is
 * the memory universe, and a peer's representation is synthesized across its
 * sessions. Narrowing is opt-in, for operators who want recall focused on the
 * conversation at hand rather than everything the peer has ever said.
 *
 * Narrowing is not a tenancy boundary. Keeping separate tenants apart belongs
 * at the workspace level, or in a scope — not in how far a single recall call
 * reaches inside a shared workspace.
 *
 * Only the automatic and ask paths are covered. The explicitly invoked tools
 * cannot be bounded uniformly on the current SDK surface: `peer.card()` takes
 * no scoping at all and `peer.search()` takes only `filters`, so a setting for
 * them would apply to some of their calls and silently skip others.
 */
export type RecallConfig = {
    automatic: RecallScope;
    ask: RecallScope;
    scopeName?: string;
};
type HonchoConnection = {
    apiKey?: string;
    workspaceId: string;
    baseUrl: string;
    sharedCredentials: boolean;
};
export type HonchoConfig = HonchoConnection & {
    timeoutMs?: number;
    noisePatterns: string[];
    disableDefaultNoisePatterns: boolean;
    captureSystemRuns: boolean;
    peerName: string;
    ownerObserveOthers: boolean;
    crossSessionSearch: boolean;
    enableMemoryCompatibilityTools: boolean;
    enableWorkspaceChat: boolean;
    degradedFallback: DegradedFallbackConfig;
    antiHits: AntiHitsConfig;
    recall: RecallConfig;
};
export declare function assertRetainedHonchoEndpoint(original: string, selected: string): void;
export declare function resolveHonchoConnection(value: unknown): HonchoConnection;
export declare const honchoConfigSchema: {
    parse(value: unknown): HonchoConfig;
};
export {};
