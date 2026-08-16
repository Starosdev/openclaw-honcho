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
/**
 * True only when the request never got an answer. Anything carrying an HTTP
 * status did, including 422, and is a real failure to surface rather than mask.
 */
export declare function isConnectionFailure(error: unknown): boolean;
export declare function readLocalEpisodes(config: DegradedFallbackConfig, readFileImpl?: (path: string, encoding: "utf8") => Promise<string>): Promise<LocalEpisode[]>;
export declare function formatDegradedContext(episodes: LocalEpisode[]): string;
export declare function buildDegradedContext(config: DegradedFallbackConfig, readFileImpl?: (path: string, encoding: "utf8") => Promise<string>): Promise<string>;
