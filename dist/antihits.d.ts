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
export type AntiHitsConfig = {
    enabled: boolean;
    /** How many of the top hits to expand. Each one costs a search. */
    expandTop: number;
    /** Neighbours requested per expanded hit. */
    expandK: number;
    /** Cap on rendered anti-hits. */
    maxAntiHits: number;
    /** Neighbour distance as a fraction of the caller's maxDistance. */
    distanceFactor: number;
};
export declare const DEFAULT_ANTI_HITS: AntiHitsConfig;
/** The subset of the SDK's Conclusion this needs. */
export type ConclusionLike = {
    id: string;
    content: string;
    createdAt: string;
};
export type ConclusionQuerier = {
    query: (query: string, topK?: number, distance?: number) => Promise<ConclusionLike[]>;
};
export type AntiHit = {
    conclusion: ConclusionLike;
    /** The hit it appears to be superseded by. */
    supersededBy: ConclusionLike;
    ageGapMs: number;
};
export declare function selectAntiHits(hits: ConclusionLike[], neighboursByHitId: Map<string, ConclusionLike[]>, config: AntiHitsConfig): AntiHit[];
export declare function collectAntiHits(scope: ConclusionQuerier, query: string, options: {
    topK: number;
    maxDistance: number;
    config: AntiHitsConfig;
}): Promise<AntiHit[]>;
export declare function formatAntiHits(antiHits: AntiHit[]): string;
