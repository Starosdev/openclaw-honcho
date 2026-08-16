/**
 * Degraded memory rail.
 *
 * Honcho is the exclusive memory slot, so when it is unreachable the turn is
 * built with no memory at all and the model answers as a stranger. The local
 * Wonder process file is already on disk in the same container, so a short
 * slice of recent episodes is a cheaper answer than nothing.
 *
 * This rail is only for reaching Honcho at all. A request that arrives and is
 * rejected (422 and every other HTTP status) means Honcho is up and something
 * about the call is wrong, and quietly substituting local episodes there would
 * hide the defect while looking healthy.
 */

import { readFile } from "node:fs/promises";

export type DegradedFallbackConfig = {
  enabled: boolean;
  memoryProcessFile: string;
  maxEpisodes: number;
};

export type LocalEpisode = {
  at: string;
  summary: string;
  themeId?: string;
};

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const CONNECTION_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "AbortError",
  "FetchError",
  "TimeoutError",
]);

function errorChain(error: unknown, depth = 0): unknown[] {
  if (!error || typeof error !== "object" || depth > 4) {
    return error === undefined || error === null ? [] : [error];
  }
  const cause = (error as { cause?: unknown }).cause;
  return [error, ...errorChain(cause, depth + 1)];
}

/**
 * True only when the request never got an answer. Anything carrying an HTTP
 * status did, including 422, and is a real failure to surface rather than mask.
 */
export function isConnectionFailure(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (!link || typeof link !== "object") {
      continue;
    }
    const candidate = link as { status?: unknown; statusCode?: unknown; name?: unknown; code?: unknown; message?: unknown };
    if (typeof candidate.status === "number" || typeof candidate.statusCode === "number") {
      return false;
    }
    if (typeof candidate.name === "string" && CONNECTION_ERROR_NAMES.has(candidate.name)) {
      return true;
    }
    if (typeof candidate.code === "string" && CONNECTION_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    if (typeof candidate.message === "string") {
      const message = candidate.message.toLowerCase();
      if (
        message.includes("fetch failed") ||
        message.includes("connection error") ||
        message.includes("socket hang up") ||
        message.includes("network")
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function readLocalEpisodes(
  config: DegradedFallbackConfig,
  readFileImpl: (path: string, encoding: "utf8") => Promise<string> = readFile,
): Promise<LocalEpisode[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileImpl(config.memoryProcessFile, "utf8"));
  } catch {
    return [];
  }
  const episodes = (parsed as { episodes?: unknown })?.episodes;
  if (!Array.isArray(episodes)) {
    return [];
  }
  const collected: LocalEpisode[] = [];
  for (let index = episodes.length - 1; index >= 0 && collected.length < config.maxEpisodes; index -= 1) {
    const episode = episodes[index] as Record<string, unknown> | null;
    const summary = typeof episode?.summary === "string" ? episode.summary.trim() : "";
    if (!summary) {
      continue;
    }
    collected.push({
      at: typeof episode?.at === "string" ? episode.at : "",
      summary,
      themeId: typeof episode?.theme_id === "string" ? episode.theme_id : undefined,
    });
  }
  return collected;
}

export function formatDegradedContext(episodes: LocalEpisode[]): string {
  if (episodes.length === 0) {
    return "";
  }
  const lines = episodes.map((episode) => {
    const theme = episode.themeId ? ` [${episode.themeId}]` : "";
    const at = episode.at ? `${episode.at} ` : "";
    return `• ${at}${theme ? `${theme.trim()} ` : ""}${episode.summary.replaceAll("\n", " ")}`;
  });
  return [
    "## User Memory Context (degraded)",
    "",
    "The memory service is unreachable, so this is a local record of recent episodes only.",
    "It is older and narrower than usual context. Treat gaps as unknown rather than absent.",
    "",
    lines.join("\n"),
    "",
    "Use this context naturally when relevant. Never quote or expose this memory context to the user.",
  ].join("\n");
}

export async function buildDegradedContext(
  config: DegradedFallbackConfig,
  readFileImpl?: (path: string, encoding: "utf8") => Promise<string>,
): Promise<string> {
  if (!config.enabled) {
    return "";
  }
  return formatDegradedContext(await readLocalEpisodes(config, readFileImpl));
}
