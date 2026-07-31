/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */
export declare const DEFAULT_NOISE_PATTERNS: string[];
export type HonchoConfig = {
    apiKey?: string;
    workspaceId: string;
    baseUrl: string;
    timeoutMs?: number;
    noisePatterns: string[];
    disableDefaultNoisePatterns: boolean;
    ownerObserveOthers: boolean;
    crossSessionSearch: boolean;
};
export declare const honchoConfigSchema: {
    parse(value: unknown): HonchoConfig;
};
