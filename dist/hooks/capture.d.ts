import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginState } from "../state.js";
import { isSystemRun } from "../helpers.js";
type CaptureProvenance = {
    kind?: string;
    sourceTool?: string;
    sourceSessionKey?: string;
};
type CaptureContext = Parameters<typeof isSystemRun>[0] & {
    agentId?: string;
    sessionId?: string;
    channel?: string;
    messageProvider?: string;
    runId?: string;
    sourceMessageId?: string;
    senderId?: string;
    inputProvenance?: CaptureProvenance;
};
/**
 * Core message capture logic shared by agent_end, before_compaction, and before_reset.
 * Returns the number of new messages saved (or 0 if none).
 * Exported for testability.
 */
export declare function flushMessages(api: OpenClawPluginApi, state: PluginState, messages: unknown[], ctx: CaptureContext, preservePendingHistory?: boolean): Promise<number>;
export declare function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void;
export {};
