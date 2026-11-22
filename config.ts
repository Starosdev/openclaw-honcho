/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ANTI_HITS, type AntiHitsConfig } from "./antihits.js";
import type { DegradedFallbackConfig } from "./degraded.js";

export const DEFAULT_NOISE_PATTERNS: string[] = [
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
export const RECALL_SCOPES = ["session", "scope", "workspace"] as const;
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

function parseRecallScope(value: unknown, fallback: RecallScope): RecallScope {
  return typeof value === "string" && (RECALL_SCOPES as readonly string[]).includes(value)
    ? (value as RecallScope)
    : fallback;
}

/**
 * Resolve environment variable references in config values.
 * Supports ${ENV_VAR} syntax.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function httpOrigin(value: string, originOnly = true): string {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username &&
        !url.password && (!originOnly || url.href === `${url.origin}/`)) {
      return url.origin;
    }
  } catch {
    // Avoid including an invalid endpoint that could itself contain credentials.
  }
  throw new Error("Shared Honcho credentials require a valid HTTP(S) origin.");
}

export function assertRetainedHonchoEndpoint(original: string, selected: string): void {
  try {
    if (httpOrigin(original, false) === httpOrigin(selected, false)) return;
  } catch {
    // An unparseable endpoint cannot safely receive the retained key.
  }
  throw new Error("Retained Honcho credential endpoint conflicts with the configured endpoint. Enter a key for the new origin.");
}

type SharedCredentials = { apiKey?: unknown; environmentUrl?: unknown };

function loadSharedCredentials(): { apiKey: string; baseUrl: string } {
  let file: (SharedCredentials & { hosts?: { openclaw?: SharedCredentials } }) | undefined;
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".honcho", "config.json"), "utf8"));
  } catch {
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

export function resolveHonchoConnection(value: unknown): HonchoConnection {
  const cfg = (value ?? {}) as Record<string, unknown>;
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
  parse(value: unknown): HonchoConfig {
    const cfg = (value ?? {}) as Record<string, unknown>;
    const peerName = cfg.peerName === undefined ? DEFAULT_OWNER_PEER_ID : cfg.peerName;
    if (typeof peerName !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(peerName) ||
        /^(?:agent-|clawtalk-|openclaw$)/i.test(peerName)) {
      throw new Error("Honcho peerName must be a valid peer ID outside the agent and ClawTalk namespaces.");
    }

    const connection = resolveHonchoConnection(cfg);

    const disableDefaultNoisePatterns = cfg.disableDefaultNoisePatterns === true;
    const userPatterns = Array.isArray(cfg.noisePatterns)
      ? (cfg.noisePatterns as unknown[])
          .filter((p): p is string => typeof p === "string")
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
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
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
        const raw = (cfg.antiHits ?? {}) as Record<string, unknown>;
        const bounded = (value: unknown, fallback: number, minimum: number, maximum: number) =>
          typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
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
        const raw = (cfg.degradedFallback ?? {}) as Record<string, unknown>;
        const maxEpisodes =
          typeof raw.maxEpisodes === "number" &&
          Number.isInteger(raw.maxEpisodes) &&
          raw.maxEpisodes >= 1 &&
          raw.maxEpisodes <= 20
            ? raw.maxEpisodes
            : 5;
        return {
          // On by default: a rail that has to be switched on during the outage
          // is not a rail. It is inert wherever the local file is absent.
          enabled: raw.enabled !== false,
          memoryProcessFile:
            typeof raw.memoryProcessFile === "string" && raw.memoryProcessFile.length > 0
              ? raw.memoryProcessFile
              : process.env.WONDER_MEMORY_PROCESS_FILE || DEFAULT_MEMORY_PROCESS_FILE,
          maxEpisodes,
        };
      })(),
      recall: (() => {
        const raw = (cfg.recall ?? {}) as Record<string, unknown>;
        const scopeName =
          typeof raw.scopeName === "string" && raw.scopeName.trim().length > 0
            ? raw.scopeName.trim()
            : undefined;
        const resolve = (value: unknown, fallback: RecallScope): RecallScope => {
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
