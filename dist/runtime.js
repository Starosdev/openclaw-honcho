import { isManagedHonchoCloud } from "./state.js";
const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 50;
const SESSION_TRANSCRIPT_CACHE_TTL_MS = 5_000;
const transcriptCaches = new WeakMap();
/** Convert a Honcho session id into the generic memory tool path shape. */
function normalizeSessionPath(sessionId) {
    return `sessions/${sessionId}.txt`;
}
/** Parse the synthetic transcript path used by memory_get back into a session id. */
function parseSessionPath(relPath) {
    const m = /^sessions\/(.+)\.txt$/.exec(relPath);
    return m ? m[1] : null;
}
/** Match the active Honcho session for scoped reads/searches. New-scheme ids
 * embed a per-session hash suffix, so no real id is a prefix of another and
 * scope-checking collapses to equality. */
function matchesSessionScope(sessionId, activeSessionKey) {
    return sessionId === activeSessionKey;
}
/** Return only the requested line window from a synthesized Honcho transcript. */
function sliceLines(text, from = 1, lines) {
    const all = text.split(/\r?\n/);
    const start = Math.max(1, from) - 1;
    const end = lines == null ? all.length : Math.min(all.length, start + Math.max(0, lines));
    return all.slice(start, end).join("\n");
}
/** Reconstruct a readable session transcript from Honcho session context data. */
async function fetchSessionTranscript(state, agentId, sessionId) {
    await state.ensureInitialized();
    const participantPeer = await state.resolveSessionParticipantPeer(sessionId);
    const agentPeer = await state.getAgentPeer(agentId);
    const session = await state.honcho.session(sessionId);
    const context = await session.context({
        summary: true,
        tokens: 20000,
        peerTarget: participantPeer,
        peerPerspective: agentPeer,
    });
    const lines = [];
    if (context.summary?.content) {
        lines.push("# Summary", context.summary.content, "");
    }
    for (const msg of context.messages ?? []) {
        const speaker = msg.peerId === participantPeer.id
            ? "User"
            : msg.peerId === agentPeer.id
                ? `Agent(${agentId})`
                : state.isParticipantPeerId(msg.peerId)
                    ? `User(${msg.peerId})`
                    : `Peer(${msg.peerId})`;
        const ts = msg.createdAt ? ` ${msg.createdAt}` : "";
        lines.push(`## ${speaker}${ts}`, msg.content ?? "", "");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}
function buildSessionTranscript(state, agentId, sessionId) {
    const cache = transcriptCaches.get(state) ?? new Map();
    transcriptCaches.set(state, cache);
    const cacheKey = `${agentId}\0${sessionId}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now)
        return cached.promise;
    const promise = fetchSessionTranscript(state, agentId, sessionId);
    cache.set(cacheKey, { expiresAt: now + SESSION_TRANSCRIPT_CACHE_TTL_MS, promise });
    promise.catch(() => {
        const current = cache.get(cacheKey);
        if (current?.promise === promise)
            cache.delete(cacheKey);
    });
    return promise;
}
/** Best-effort map a matched snippet back to transcript line numbers for memory_search. */
function findSnippetLineRange(transcript, snippet) {
    const transcriptLines = transcript.split(/\r?\n/);
    const snippetLines = snippet.split(/\r?\n/);
    if (!snippet.trim()) {
        return { startLine: 1, endLine: 1 };
    }
    for (let i = 0; i <= transcriptLines.length - snippetLines.length; i += 1) {
        let matches = true;
        for (let j = 0; j < snippetLines.length; j += 1) {
            if (transcriptLines[i + j] !== snippetLines[j]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return { startLine: i + 1, endLine: i + snippetLines.length };
        }
    }
    const firstNeedle = snippetLines.find((line) => line.trim().length > 0);
    if (firstNeedle) {
        const idx = transcriptLines.findIndex((line) => line.includes(firstNeedle));
        if (idx >= 0) {
            return {
                startLine: idx + 1,
                endLine: Math.min(transcriptLines.length, idx + snippetLines.length),
            };
        }
    }
    return {
        startLine: 1,
        endLine: Math.min(Math.max(1, transcriptLines.length), Math.max(1, snippetLines.length)),
    };
}
/**
 * Build a Honcho-backed memory manager that satisfies OpenClaw's active-memory contract.
 *
 * The returned manager powers both the registered memory runtime and the direct
 * memory_search / memory_get compatibility tools.
 */
export async function getHonchoMemorySearchManager(state, params = {}) {
    const { agentId = state.resolveDefaultAgentId(), sessionKey: activeSessionKey } = params;
    await state.ensureInitialized();
    return {
        manager: {
            async search(query, opts = {}) {
                await state.ensureInitialized();
                // The active-memory contract scopes per call (search opts.sessionKey);
                // fall back to the key captured at manager creation for the legacy /
                // passthrough-tool path.
                const sessionKey = opts.sessionKey ?? activeSessionKey;
                const participantPeer = sessionKey
                    ? await state.resolveSessionParticipantPeer(sessionKey)
                    : await state.getParticipantPeer();
                const requested = Number.isFinite(opts.maxResults)
                    ? Number(opts.maxResults)
                    : DEFAULT_SEARCH_RESULTS;
                const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(requested)));
                const crossSession = opts.crossSessionSearch ?? state.cfg.crossSessionSearch;
                const rawResults = crossSession || !sessionKey
                    ? await participantPeer.search(query, { limit })
                    : await (await state.honcho.session(sessionKey, { metadata: { agentId } })).search(query, { limit });
                const seen = new Set();
                const filtered = [];
                for (const msg of rawResults) {
                    if (filtered.length >= limit)
                        break;
                    const sessionId = typeof msg?.sessionId === "string" ? msg.sessionId : "";
                    if (!sessionId)
                        continue;
                    const dedupeKey = `${sessionId}:${String(msg?.id ?? msg?.createdAt ?? msg?.content ?? "")}`;
                    if (seen.has(dedupeKey))
                        continue;
                    seen.add(dedupeKey);
                    filtered.push(msg);
                }
                const transcriptCache = new Map();
                return Promise.all(filtered.map(async (msg) => {
                    const snippet = typeof msg.content === "string" ? msg.content : "";
                    let transcriptPromise = transcriptCache.get(msg.sessionId);
                    if (!transcriptPromise) {
                        transcriptPromise = buildSessionTranscript(state, agentId, msg.sessionId);
                        transcriptCache.set(msg.sessionId, transcriptPromise);
                    }
                    const transcript = await transcriptPromise;
                    const { startLine, endLine } = findSnippetLineRange(transcript, snippet);
                    return {
                        path: normalizeSessionPath(msg.sessionId),
                        startLine,
                        endLine,
                        score: 1,
                        snippet,
                        source: "sessions",
                    };
                }));
            },
            async readFile(params) {
                const sessionId = parseSessionPath(params.relPath);
                if (!sessionId) {
                    throw new Error(`Unsupported Honcho memory path: ${params.relPath}`);
                }
                if (!state.cfg.crossSessionSearch && activeSessionKey && !matchesSessionScope(sessionId, activeSessionKey)) {
                    throw new Error(`Requested Honcho memory path is outside the active session: ${params.relPath}`);
                }
                const transcript = await buildSessionTranscript(state, agentId, sessionId);
                return {
                    path: params.relPath,
                    text: sliceLines(transcript, params.from, params.lines),
                };
            },
            status() {
                return {
                    backend: "qmd",
                    provider: isManagedHonchoCloud(state.cfg.baseUrl) ? "honcho" : "honcho-selfhosted",
                    model: "n/a",
                    sources: ["sessions"],
                    custom: {
                        searchMode: "semantic",
                        workspaceId: state.cfg.workspaceId,
                        baseUrl: state.cfg.baseUrl,
                    },
                };
            },
            async probeEmbeddingAvailability() {
                return { ok: true };
            },
            async probeVectorAvailability() {
                return true;
            },
        },
    };
}
/** Resolve the memory backend descriptor expected by the OpenClaw memory slot. */
export function resolveHonchoMemoryBackendConfig(_params = {}) {
    return {
        backend: "qmd",
        qmd: {},
    };
}
/** Build the Honcho adapter for OpenClaw's active memory capability.
 *
 * The current host contract creates a session-agnostic manager here and passes
 * the active session key per call via `search(query, { sessionKey })`, so this
 * adapter does not forward a session key at creation time. Session-scoped reads
 * still flow through the memory_search / memory_get passthrough tools, which
 * resolve the session key from their tool context. */
export function createHonchoMemoryRuntime(state) {
    return {
        async getMemorySearchManager(params) {
            return getHonchoMemorySearchManager(state, { agentId: params.agentId });
        },
        resolveMemoryBackendConfig(params = {}) {
            return resolveHonchoMemoryBackendConfig(params);
        },
    };
}
