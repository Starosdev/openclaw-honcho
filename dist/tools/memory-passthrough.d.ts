import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
/** Register host-compatible memory_search and memory_get tools for Honcho-backed memory. */
export declare function registerMemoryPassthrough(api: OpenClawPluginApi, state: PluginState): void;
