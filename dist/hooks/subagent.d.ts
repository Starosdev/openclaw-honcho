import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
/**
 * Module-level singleton: childSessionKey → parent agent ID.
 * Populated by subagent_spawned; read by agent_end in capture.ts.
 */
export declare const subagentParentMap: Map<string, string>;
export declare function registerSubagentHooks(api: OpenClawPluginApi): void;
