/**
 * OpenClaw Memory (Honcho) Plugin
 *
 * AI-native memory with dialectic reasoning for OpenClaw.
 * Uses Honcho's peer paradigm for multi-party conversation memory.
 */
import type { MemoryPluginCapability, OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
/**
 * Memory prompt section builder for Honcho tools.
 * This is the single place for tool-selection guidance — tool descriptions
 * themselves stay short to minimize per-turn token overhead.
 */
export declare const buildPromptSection: NonNullable<MemoryPluginCapability["promptBuilder"]>;
declare const honchoPlugin: OpenClawPluginDefinition;
export default honchoPlugin;
