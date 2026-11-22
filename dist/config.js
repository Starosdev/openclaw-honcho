/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ANTI_HITS } from "./antihits.js";
export const DEFAULT_NOISE_PATTERNS = [
    "HEARTBEAT_OK",
    "[OpenClaw heartbeat poll]",
    "A scheduled reminder has been triggered",
    "Execute your Session Startup sequence now",
    "Queued messages from",
];
export const DEFAULT_MEMORY_PROCESS_FILE = "/opt/openclaw/vega-data/vega-memory-process.json";
export const DEFAULT_OWNER_PEER_ID = "owner";
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
export const RECALL_SCOPES = ["session", "scope", "workspace"];
function parseRecallScope(value, fallback) {
    return typeof value === "string" && RECALL_SCOPES.includes(value)
        ? value
        : fallback;
}
/**
 * Resolve environment variable references in config values.
 * Supports ${ENV_VAR} syntax.
 */
function resolveEnvVars(value) {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
        const envValue = process.env[envVar];
        if (!envValue) {
            throw new Error(`Environment variable ${envVar} is not set`);
        }
        return envValue;
    });
}
function httpOrigin(value, originOnly = true) {
    try {
        const url = new URL(value);
        if ((url.protocol === "https:" || url.protocol === "http:") && !url.username &&
            !url.password && (!originOnly || url.href === `${url.origin}/`)) {
            return url.origin;
        }
    }
    catch {
        // Avoid including an invalid endpoint that could itself contain credentials.
    }
    throw new Error("Shared Honcho credentials require a valid HTTP(S) origin.");
}
export function assertRetainedHonchoEndpoint(original, selected) {
    try {
        if (httpOrigin(original, false) === httpOrigin(selected, false))
            return;
    }
    catch {
        // An unparseable endpoint cannot safely receive the retained key.
    }
    throw new Error("Retained Honcho credential endpoint conflicts with the configured endpoint. Enter a key for the new origin.");
}
function loadSharedCredentials() {
    let file;
    try {
        file = JSON.parse(readFileSync(join(homedir(), ".honcho", "config.json"), "utf8"));
    }
    catch {
        throw new Error("Shared Honcho configuration is unavailable or invalid.");
    }
    const host = file?.hosts?.openclaw;
    // A host override supplies a pair. Never inherit one half from the root.
    const selected = host && (host.apiKey !== undefined || host.environmentUrl !== undefined) ? host : file;
    if (typeof selected?.apiKey !== "string" || !selected.apiKey.trim() ||
        typeof selected.environmentUrl !== "string" || !selected.environmentUrl.trim()) {
        throw new Error("Shared Honcho credentials require an API key and endpoint in the same configuration scope.");
    }
    return { apiKey: selected.apiKey.trim(), baseUrl: httpOrigin(selected.environmentUrl) };
}
export function resolveHonchoConnection(value) {
    const cfg = (value ?? {});
    const apiKey = typeof cfg.apiKey === "string" && cfg.apiKey.length > 0
        ? resolveEnvVars(cfg.apiKey)
        : process.env.HONCHO_API_KEY;
    const configuredEndpoint = typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
        ? cfg.baseUrl
        : process.env.HONCHO_BASE_URL;
    const workspaceId = typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0
        ? cfg.workspaceId
        : process.env.HONCHO_WORKSPACE_ID ?? "openclaw";
    if (!apiKey && cfg.enableSharedConfigCredentials === true) {
        const shared = loadSharedCredentials();
        if (configuredEndpoint && httpOrigin(configuredEndpoint) !== shared.baseUrl) {
            throw new Error("Shared Honcho credential endpoint conflicts with the configured endpoint.");
        }
        return { ...shared, workspaceId, sharedCredentials: true };
    }
    return {
        apiKey, baseUrl: configuredEndpoint ?? "https://api.honcho.dev", workspaceId, sharedCredentials: false,
    };
}
export const honchoConfigSchema = {
    parse(value) {
        const cfg = (value ?? {});
        const peerName = cfg.peerName === undefined ? DEFAULT_OWNER_PEER_ID : cfg.peerName;
        if (typeof peerName !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(peerName) ||
            /^(?:agent-|clawtalk-|openclaw$)/i.test(peerName)) {
            throw new Error("Honcho peerName must be a valid peer ID outside the agent and ClawTalk namespaces.");
        }
        const connection = resolveHonchoConnection(cfg);
        const disableDefaultNoisePatterns = cfg.disableDefaultNoisePatterns === true;
        const userPatterns = Array.isArray(cfg.noisePatterns)
            ? cfg.noisePatterns
                .filter((p) => typeof p === "string")
                .map((p) => p.trim())
                .filter((p) => p.length > 0)
            : [];
        const noisePatterns = [
            ...new Set([...(disableDefaultNoisePatterns ? [] : DEFAULT_NOISE_PATTERNS), ...userPatterns]),
        ];
        return {
            ...connection,
            timeoutMs: (() => {
                if (typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0) {
                    return cfg.timeoutMs;
                }
                if (process.env.HONCHO_TIMEOUT_MS !== undefined) {
                    const parsed = Number(process.env.HONCHO_TIMEOUT_MS);
                    if (Number.isFinite(parsed) && parsed > 0)
                        return parsed;
                }
                return undefined;
            })(),
            noisePatterns,
            disableDefaultNoisePatterns,
            captureSystemRuns: cfg.captureSystemRuns === true,
            peerName,
            ownerObserveOthers: typeof cfg.ownerObserveOthers === "boolean" ? cfg.ownerObserveOthers : false,
            crossSessionSearch: typeof cfg.crossSessionSearch === "boolean" ? cfg.crossSessionSearch : true,
            enableMemoryCompatibilityTools: cfg.enableMemoryCompatibilityTools === true,
            enableWorkspaceChat: cfg.enableWorkspaceChat === true,
            antiHits: (() => {
                const raw = (cfg.antiHits ?? {});
                const bounded = (value, fallback, minimum, maximum) => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
                    ? value
                    : fallback;
                return {
                    enabled: raw.enabled !== false,
                    // Each expanded hit costs one extra search, so this bound is the
                    // whole cost control for the tool call.
                    expandTop: bounded(raw.expandTop, DEFAULT_ANTI_HITS.expandTop, 0, 5),
                    expandK: bounded(raw.expandK, DEFAULT_ANTI_HITS.expandK, 1, 20),
                    maxAntiHits: bounded(raw.maxAntiHits, DEFAULT_ANTI_HITS.maxAntiHits, 0, 10),
                    distanceFactor: bounded(raw.distanceFactor, DEFAULT_ANTI_HITS.distanceFactor, 0.1, 1),
                };
            })(),
            degradedFallback: (() => {
                const raw = (cfg.degradedFallback ?? {});
                const maxEpisodes = typeof raw.maxEpisodes === "number" &&
                    Number.isInteger(raw.maxEpisodes) &&
                    raw.maxEpisodes >= 1 &&
                    raw.maxEpisodes <= 20
                    ? raw.maxEpisodes
                    : 5;
                return {
                    // On by default: a rail that has to be switched on during the outage
                    // is not a rail. It is inert wherever the local file is absent.
                    enabled: raw.enabled !== false,
                    memoryProcessFile: typeof raw.memoryProcessFile === "string" && raw.memoryProcessFile.length > 0
                        ? raw.memoryProcessFile
                        : process.env.WONDER_MEMORY_PROCESS_FILE || DEFAULT_MEMORY_PROCESS_FILE,
                    maxEpisodes,
                };
            })(),
            recall: (() => {
                const raw = (cfg.recall ?? {});
                const scopeName = typeof raw.scopeName === "string" && raw.scopeName.trim().length > 0
                    ? raw.scopeName.trim()
                    : undefined;
                const resolve = (value, fallback) => {
                    const parsed = parseRecallScope(value, fallback);
                    // "scope" without a name has no boundary to apply. Fall back to the
                    // session rather than silently widening to the whole workspace.
                    return parsed === "scope" && !scopeName ? "session" : parsed;
                };
                return {
                    automatic: resolve(raw.automatic, "workspace"),
                    ask: resolve(raw.ask, "workspace"),
                    scopeName,
                };
            })(),
        };
    },
};
