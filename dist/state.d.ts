/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 */
import { Honcho, type Peer } from "@honcho-ai/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type HonchoConfig } from "./config.js";
import { PeersPersister } from "./peers.js";
export declare const OWNER_ID = "owner";
export declare const LEGACY_PEER_ID = "openclaw";
export declare const HONCHO_CLOUD_HOSTNAME = "api.honcho.dev";
/**
 * True when the base URL points at the managed Honcho cloud
 * (api.honcho.dev). The cloud is the only deployment that requires an API
 * key; any other base URL — localhost or a custom self-hosted domain — is
 * treated as self-hosted.
 */
export declare function isManagedHonchoCloud(baseUrl: string): boolean;
export type PluginState = {
    honcho: Honcho;
    cfg: HonchoConfig;
    /** Cache of resolved participant peers, keyed by channel peer ID (or OWNER_ID for default).
     * "Participant" intentionally generalizes over humans AND non-agent bots/agents in group
     * chats — anyone in the conversation who isn't the local OpenClaw agent peer. */
    participantPeers: Map<string, Peer>;
    agentPeers: Map<string, Peer>;
    agentPeerMap: Record<string, string>;
    /** Message count recorded at before_prompt_build time, keyed by Honcho session key.
     * Used by the capture hook to determine where the current turn starts in the
     * accumulated message array, so first-init skips pre-installation history. */
    turnStartIndex: Map<string, number>;
    initialized: boolean;
    api: OpenClawPluginApi;
    ensureInitialized: () => Promise<void>;
    getAgentPeer: (agentId?: string) => Promise<Peer>;
    /** Sender_id → Honcho peer_id map, backed by ~/.honcho/openclaw-peers.json.
     * Unknown senders are auto-seeded to OWNER_ID; the user hand-edits the file
     * to split specific senders off to their own peer IDs. */
    peersPersister: PeersPersister;
    /** Resolve a participant peer by channel peer ID. Returns default "owner" peer if no ID given. */
    getParticipantPeer: (channelPeerId?: string) => Promise<Peer>;
    /** Resolve the participant peer for a session by reading participantSenderId from session metadata.
     * Falls back to default "owner" peer if no metadata found. */
    resolveSessionParticipantPeer: (sessionKey: string) => Promise<Peer>;
    /** Returns true if the given honcho peer ID belongs to a known participant peer. */
    isParticipantPeerId: (peerId: string) => boolean;
    resolveDefaultAgentId: () => string;
};
export declare function createPluginState(api: OpenClawPluginApi): PluginState;
