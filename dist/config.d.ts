/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */
import type { DegradedFallbackConfig } from "./degraded.js";
export declare const DEFAULT_NOISE_PATTERNS: string[];
export declare const DEFAULT_MEMORY_PROCESS_FILE = "/opt/openclaw/vega-data/vega-memory-process.json";
export type HonchoConfig = {
    apiKey?: string;
    workspaceId: string;
    baseUrl: string;
    timeoutMs?: number;
    noisePatterns: string[];
    disableDefaultNoisePatterns: boolean;
    ownerObserveOthers: boolean;
    crossSessionSearch: boolean;
    degradedFallback: DegradedFallbackConfig;
};
export declare const honchoConfigSchema: {
    parse(value: unknown): HonchoConfig;
};
