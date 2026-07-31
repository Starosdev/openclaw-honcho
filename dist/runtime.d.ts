import type { MemoryPluginCapability } from "openclaw/plugin-sdk/core";
import { type PluginState } from "./state.js";
/**
 * Build a Honcho-backed memory manager that satisfies OpenClaw's active-memory contract.
 *
 * The returned manager powers both the registered memory runtime and the direct
 * memory_search / memory_get compatibility tools.
 */
export declare function getHonchoMemorySearchManager(state: PluginState, params?: {
    agentId?: string;
    sessionKey?: string;
}): Promise<{
    manager: {
        search(query: string, opts?: {
            maxResults?: number;
            crossSessionSearch?: boolean;
            sessionKey?: string;
        }): Promise<{
            path: string;
            startLine: number;
            endLine: number;
            score: number;
            snippet: any;
            source: "sessions";
        }[]>;
        readFile(params: {
            relPath: string;
            from?: number;
            lines?: number;
        }): Promise<{
            path: string;
            text: string;
        }>;
        status(): {
            backend: "qmd";
            provider: string;
            model: string;
            sources: "sessions"[];
            custom: {
                searchMode: string;
                workspaceId: string;
                baseUrl: string;
            };
        };
        probeEmbeddingAvailability(): Promise<{
            ok: boolean;
        }>;
        probeVectorAvailability(): Promise<boolean>;
    };
}>;
/** Resolve the memory backend descriptor expected by the OpenClaw memory slot. */
export declare function resolveHonchoMemoryBackendConfig(_params?: {
    agentId?: string;
}): {
    backend: "qmd";
    qmd: {};
};
/** Build the Honcho adapter for OpenClaw's active memory capability.
 *
 * The current host contract creates a session-agnostic manager here and passes
 * the active session key per call via `search(query, { sessionKey })`, so this
 * adapter does not forward a session key at creation time. Session-scoped reads
 * still flow through the memory_search / memory_get passthrough tools, which
 * resolve the session key from their tool context. */
export declare function createHonchoMemoryRuntime(state: PluginState): NonNullable<MemoryPluginCapability["runtime"]>;
