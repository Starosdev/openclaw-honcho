/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */
export const DEFAULT_NOISE_PATTERNS = [
    "HEARTBEAT_OK",
    "A scheduled reminder has been triggered",
    "Execute your Session Startup sequence now",
    "Queued messages from",
];
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
export const honchoConfigSchema = {
    parse(value) {
        const cfg = (value ?? {});
        // Resolve API key with env var fallback
        let apiKey;
        if (typeof cfg.apiKey === "string" && cfg.apiKey.length > 0) {
            apiKey = resolveEnvVars(cfg.apiKey);
        }
        else {
            apiKey = process.env.HONCHO_API_KEY;
        }
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
            apiKey,
            workspaceId: typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0
                ? cfg.workspaceId
                : process.env.HONCHO_WORKSPACE_ID ?? "openclaw",
            baseUrl: typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
                ? cfg.baseUrl
                : process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev",
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
            ownerObserveOthers: typeof cfg.ownerObserveOthers === "boolean" ? cfg.ownerObserveOthers : false,
            crossSessionSearch: typeof cfg.crossSessionSearch === "boolean" ? cfg.crossSessionSearch : true,
        };
    },
};
