import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
/**
 * Core message capture logic shared by agent_end, before_compaction, and before_reset.
 * Returns the number of new messages saved (or 0 if none).
 * Exported for testability.
 */
export declare function flushMessages(api: OpenClawPluginApi, state: PluginState, messages: unknown[], ctx: {
    sessionKey?: string;
    agentId?: string;
    sessionId?: string;
    messageProvider?: string;
}): Promise<number>;
export declare function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void;
