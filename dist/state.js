/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 */
import { DEFAULT_OWNER_PEER_ID, honchoConfigSchema, isOwnerPeerId } from "./config.js";
import { isClawTalkSession } from "./helpers.js";
import { createHonchoClient } from "./honcho-client.js";
import { PeersPersister, loadPeersFileSync, resolvePeersFilePath, resolveParticipantPeerId, } from "./peers.js";
export const LEGACY_PEER_ID = "openclaw";
const CLAWTALK_PEER_ID = /^clawtalk-gateway-device-[a-f0-9]{64}$/;
export const HONCHO_CLOUD_HOSTNAME = "api.honcho.dev";
/**
 * True when the base URL points at the managed Honcho cloud
 * (api.honcho.dev). The cloud is the only deployment that requires an API
 * key; any other base URL — localhost or a custom self-hosted domain — is
 * treated as self-hosted.
 */
export function isManagedHonchoCloud(baseUrl) {
    try {
        return new URL(baseUrl).hostname.toLowerCase() === HONCHO_CLOUD_HOSTNAME;
    }
    catch {
        return false;
    }
}
export function createPluginState(api) {
    const cfg = honchoConfigSchema.parse(api.pluginConfig);
    const selfHosted = !isManagedHonchoCloud(cfg.baseUrl);
    if (!cfg.apiKey && !selfHosted) {
        api.logger.warn("openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config.");
    }
    const honcho = createHonchoClient({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl,
        workspaceId: cfg.workspaceId,
        timeout: cfg.timeoutMs,
    });
    const peersFilePath = resolvePeersFilePath();
    const peersPersister = new PeersPersister(peersFilePath, loadPeersFileSync(peersFilePath));
    // Promise-based init lock to prevent concurrent ensureInitialized() races.
    // Without this, two concurrent hooks entering init simultaneously can corrupt
    // workspace metadata. Errors propagate to all waiters.
    let initPromise = null;
    let ownerPeer;
    const sessionParticipantPeerCache = new Map();
    const state = {
        honcho,
        cfg,
        participantPeers: new Map(),
        agentPeers: new Map(),
        agentPeerMap: {},
        turnStartIndex: new Map(),
        initialized: false,
        api,
        peersPersister,
        ensureInitialized,
        getAgentPeer,
        getParticipantPeer,
        getClawTalkParticipantPeer,
        resolveSessionParticipantPeer,
        invalidateSessionParticipantPeer,
        resolveToolParticipantPeer,
        isParticipantPeerId,
        resolveDefaultAgentId,
    };
    function resolveDefaultAgentId() {
        const agents = api.config?.agents?.list;
        if (!Array.isArray(agents) || agents.length === 0)
            return "main";
        const defaultAgent = agents.find((a) => a?.default) ?? agents[0];
        return (defaultAgent?.id ?? "main").toLowerCase().trim() || "main";
    }
    async function ensureInitialized() {
        if (state.initialized)
            return;
        if (initPromise)
            return initPromise;
        initPromise = doInit();
        try {
            await initPromise;
        }
        catch (err) {
            // Reset so next caller retries instead of getting a stale rejection.
            initPromise = null;
            throw err;
        }
    }
    async function doInit() {
        const wsMeta = await honcho.getMetadata();
        state.agentPeerMap = wsMeta.agentPeerMap ?? {};
        if (cfg.peerName !== DEFAULT_OWNER_PEER_ID &&
            Object.values(state.agentPeerMap).includes(cfg.peerName)) {
            throw new Error("Honcho peerName is already assigned to an agent.");
        }
        const defaultId = resolveDefaultAgentId();
        if (Object.keys(state.agentPeerMap).length === 0) {
            state.agentPeerMap[defaultId] = `agent-${defaultId}`;
            await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap });
        }
        else if (Object.values(state.agentPeerMap).includes(LEGACY_PEER_ID) && !state.agentPeerMap[defaultId]) {
            state.agentPeerMap[defaultId] = LEGACY_PEER_ID;
            await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap });
        }
        await ensureOwnerPeer();
        state.initialized = true;
    }
    async function ensureOwnerPeer() {
        if (ownerPeer)
            return ownerPeer;
        const peer = await honcho.peer(cfg.peerName);
        if (cfg.peerName !== DEFAULT_OWNER_PEER_ID && peer.metadata?.agentId) {
            throw new Error("Honcho peerName is already assigned to an agent.");
        }
        ownerPeer = peer;
        return peer;
    }
    async function getParticipantPeer(channelPeerId) {
        if (!channelPeerId)
            return ensureOwnerPeer();
        if (CLAWTALK_PEER_ID.test(channelPeerId) || CLAWTALK_PEER_ID.test(peersPersister.peers[channelPeerId] ?? "")) {
            throw new Error("ClawTalk device peers require an authenticated device context.");
        }
        // Known senders resolve via the peers file. Unknown senders auto-seed
        // per the persister's defaultUnknownPolicy: legacy installs merge into
        // the owner peer; fresh installs derive a distinct peer from the sender ID.
        let peer = state.participantPeers.get(channelPeerId);
        if (peer)
            return peer;
        const wasInFile = channelPeerId in peersPersister.peers;
        const resolvedPeerId = resolveParticipantPeerId(channelPeerId, peersPersister, cfg.peerName);
        if (CLAWTALK_PEER_ID.test(resolvedPeerId)) {
            throw new Error("ClawTalk device peers require an authenticated device context.");
        }
        const autoSeeded = !wasInFile && !isOwnerPeerId(resolvedPeerId, cfg.peerName);
        if (resolvedPeerId === cfg.peerName) {
            peer = await ensureOwnerPeer();
        }
        else if (resolvedPeerId === DEFAULT_OWNER_PEER_ID) {
            peer = await honcho.peer(resolvedPeerId);
        }
        else {
            const metadata = { channelPeerId };
            if (autoSeeded)
                metadata.autoSeeded = true;
            peer = await honcho.peer(resolvedPeerId, { metadata });
        }
        state.participantPeers.set(channelPeerId, peer);
        return peer;
    }
    async function getClawTalkParticipantPeer(senderId) {
        if (!senderId || !/^gateway-device-[a-f0-9]{64}$/.test(senderId)) {
            throw new Error("Honcho requires a verified ClawTalk device.");
        }
        // Dedicated peer namespace bypasses legacy unknown-sender owner mapping.
        const peerId = `clawtalk-${senderId}`;
        const cached = state.participantPeers.get(peerId);
        if (cached)
            return cached;
        const peer = await honcho.peer(peerId);
        state.participantPeers.set(peerId, peer);
        return peer;
    }
    async function resolveSessionParticipantPeer(sessionKey) {
        const cached = sessionParticipantPeerCache.get(sessionKey);
        if (cached)
            return cached;
        const resolution = (async () => {
            const session = await honcho.session(sessionKey);
            const meta = await session.getMetadata();
            if (meta && typeof meta === "object") {
                const { participantSenderId: senderId, openclawSessionKey } = meta;
                if (typeof openclawSessionKey === "string" && isClawTalkSession(openclawSessionKey)) {
                    return await getClawTalkParticipantPeer(typeof senderId === "string" ? senderId : undefined);
                }
                if (typeof senderId === "string" && senderId.length > 0) {
                    return await getParticipantPeer(senderId);
                }
            }
            return await getParticipantPeer();
        })();
        sessionParticipantPeerCache.set(sessionKey, resolution);
        try {
            return await resolution;
        }
        catch (error) {
            if (sessionParticipantPeerCache.get(sessionKey) === resolution) {
                sessionParticipantPeerCache.delete(sessionKey);
            }
            throw error;
        }
    }
    function invalidateSessionParticipantPeer(sessionKey) {
        sessionParticipantPeerCache.delete(sessionKey);
    }
    async function resolveToolParticipantPeer(requester) {
        // Session metadata names whoever capture saw last, which in a shared
        // session is often not the person asking. The tool context names the
        // requester for this run, the same sender capture will attribute it to.
        const senderId = requester.requesterSenderId?.trim();
        if (isClawTalkSession(requester.sessionKey))
            return getClawTalkParticipantPeer(senderId);
        if (senderId) {
            const peer = await getParticipantPeer(senderId);
            if (!isOwnerPeerId(peer.id, cfg.peerName) || requester.senderIsOwner === true)
                return peer;
            throw new Error("Honcho owner memory requires a verified owner.");
        }
        // Operator turns (TUI, Control UI) carry no sender id; capture files them
        // under the owner peer, so read them back from there.
        if (requester.senderIsOwner === true)
            return getParticipantPeer();
        throw new Error("Honcho requires a trusted requester identity.");
    }
    function isParticipantPeerId(peerId) {
        if (isOwnerPeerId(peerId, cfg.peerName))
            return true;
        // Check if this peer ID is a known participant peer
        for (const [, peer] of state.participantPeers) {
            if (peer.id === peerId)
                return true;
        }
        return false;
    }
    async function getAgentPeer(agentId) {
        const id = (agentId || resolveDefaultAgentId()).toLowerCase().trim() || "main";
        let peer = state.agentPeers.get(id);
        if (peer)
            return peer;
        let peerId = state.agentPeerMap[id];
        if (!peerId) {
            const allPeers = await honcho.peers();
            for await (const p of allPeers) {
                if (isOwnerPeerId(p.id, cfg.peerName))
                    continue;
                const meta = await p.getMetadata();
                if (meta?.agentId === id) {
                    peerId = p.id;
                    api.logger.info(`[honcho] Recovered peer "${peerId}" for renamed agent "${id}"`);
                    break;
                }
            }
        }
        if (!peerId) {
            peerId = `agent-${id}`;
        }
        if (state.agentPeerMap[id] !== peerId) {
            state.agentPeerMap[id] = peerId;
            const wsMeta = await honcho.getMetadata();
            await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap });
        }
        peer = await honcho.peer(peerId);
        state.agentPeers.set(id, peer);
        const existingMeta = await peer.getMetadata();
        if (existingMeta.agentId !== id) {
            await peer.setMetadata({ ...existingMeta, agentId: id });
        }
        return peer;
    }
    return state;
}
