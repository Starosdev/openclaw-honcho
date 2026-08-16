/**
 * Anti-hits for conclusion search.
 *
 * Honcho never overwrites a conclusion, so when something about the user
 * changes the store ends up holding both statements and a search returns
 * whichever is closer to the query. The model then reads a single confident
 * line with no sign that a competing one exists.
 *
 * There is no contradiction link in the schema to ask for, so this finds the
 * next best thing: for each top hit, its close semantic neighbours that are
 * OLDER and say something different. Those are the statements the hit most
 * plausibly supersedes. It is a supersession signal, not a proof of
 * contradiction, and the rendered section says so.
 *
 * Scope matters and was checked against the running server rather than
 * assumed. `peer.representation({searchQuery})` sends no target, and
 * `routers/peers.py` then calls `get_working_representation(observer=peer_id,
 * observed=peer_id)`, which filters `Document.observer == observer AND
 * Document.observed == observed`. `peer.conclusions` is that same self scope,
 * and `/conclusions/query` reaches the same `crud.query_documents`. So the
 * anti-hits below describe the same observer relation as the matches they sit
 * under.
 *
 * Only `id`, `content`, `observer`, `observed`, `session_name` and
 * `created_at` cross the API boundary (`schemas/api.py` `Conclusion`).
 * `times_derived`, which would rank supersession better than age does, stays
 * server-side, and exposing it is an upstream Honcho change this fork does not
 * make.
 */
export const DEFAULT_ANTI_HITS = {
    enabled: true,
    expandTop: 2,
    expandK: 4,
    maxAntiHits: 3,
    distanceFactor: 0.6,
};
function parsedTime(value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}
function normalized(content) {
    return content.trim().toLowerCase().replace(/\s+/g, " ");
}
export function selectAntiHits(hits, neighboursByHitId, config) {
    const hitIds = new Set(hits.map((hit) => hit.id));
    const hitContents = new Set(hits.map((hit) => normalized(hit.content)));
    const claimed = new Set();
    const collected = [];
    for (const hit of hits.slice(0, config.expandTop)) {
        const hitAt = parsedTime(hit.createdAt);
        for (const neighbour of neighboursByHitId.get(hit.id) ?? []) {
            if (hitIds.has(neighbour.id) || claimed.has(neighbour.id)) {
                continue;
            }
            // A neighbour repeating what a hit already says is a duplicate, not a
            // competing statement.
            if (hitContents.has(normalized(neighbour.content))) {
                continue;
            }
            const neighbourAt = parsedTime(neighbour.createdAt);
            // Only older statements. A newer neighbour is not something this hit
            // supersedes, and may itself be the current truth.
            if (!neighbourAt || !hitAt || neighbourAt >= hitAt) {
                continue;
            }
            claimed.add(neighbour.id);
            collected.push({ conclusion: neighbour, supersededBy: hit, ageGapMs: hitAt - neighbourAt });
        }
    }
    // Widest gap first: the statement the store has most visibly moved on from.
    return [...collected]
        .sort((left, right) => right.ageGapMs - left.ageGapMs)
        .slice(0, Math.max(0, config.maxAntiHits));
}
export async function collectAntiHits(scope, query, options) {
    const config = options.config;
    if (!config.enabled || config.expandTop < 1 || config.maxAntiHits < 1) {
        return [];
    }
    const hits = await scope.query(query, options.topK, options.maxDistance);
    if (hits.length === 0) {
        return [];
    }
    const expanded = hits.slice(0, config.expandTop);
    const neighbourLists = await Promise.all(expanded.map(async (hit) => 
    // A neighbour search is deliberately tighter than the caller's threshold:
    // at the caller's own distance it drifts onto merely related subjects.
    scope.query(hit.content, config.expandK, options.maxDistance * config.distanceFactor)));
    const neighboursByHitId = new Map();
    expanded.forEach((hit, index) => {
        neighboursByHitId.set(hit.id, neighbourLists[index] ?? []);
    });
    return selectAntiHits(hits, neighboursByHitId, config);
}
function isoDay(value) {
    const parsed = parsedTime(value);
    return parsed ? new Date(parsed).toISOString().slice(0, 10) : "undated";
}
export function formatAntiHits(antiHits) {
    if (antiHits.length === 0) {
        return "";
    }
    const lines = antiHits.map((antiHit) => `- [${isoDay(antiHit.conclusion.createdAt)}] ${antiHit.conclusion.content.replaceAll("\n", " ")}\n  (a newer conclusion from ${isoDay(antiHit.supersededBy.createdAt)} covers the same ground)`);
    return [
        "### Older conclusions on the same ground",
        "",
        "These are close matches to the results above that predate them. Honcho keeps",
        "superseded statements rather than overwriting them, so treat these as what",
        "may have changed, not as current facts. Nothing here is a proven contradiction.",
        "",
        lines.join("\n"),
    ].join("\n");
}
