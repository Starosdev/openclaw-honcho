/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 */
import { DEFAULT_OWNER_PEER_ID, honchoConfigSchema } from "./config.js";
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
const OWNER_POLICY_SESSION_ID = "openclaw-owner-policy";
async function readWorkspaceOwnerIds(honcho) {
    const ownerPeerIds = new Set([DEFAULT_OWNER_PEER_ID]);
    const workspace = encodeURIComponent(honcho.workspaceId);
    const path = `/v3/workspaces/${workspace}/sessions/${OWNER_POLICY_SESSION_ID}/peers`;
    for (let page = 1;; page++) {
        try {
            const result = await honcho.http.get(path, { query: { page } });
            if (!Number.isSafeInteger(result.pages) || result.pages < 0) {
                throw new Error("Invalid Honcho owner policy pagination.");
            }
            for (const peer of result.items)
                ownerPeerIds.add(peer.id);
            if (page >= result.pages)
                return ownerPeerIds;
        }
        catch (error) {
            if (page === 1 && error instanceof Error && error.name === "NotFoundError") {
                return ownerPeerIds;
            }
            throw error;
        }
    }
}
/** Persist protected owner IDs through additive membership, apart from workspace metadata. */
export async function resolveWorkspaceOwner(honcho, peerName, metadata) {
    const ownerPeerIds = await readWorkspaceOwnerIds(honcho);
    const agentPeerMap = metadata.agentPeerMap ?? {};
    if (Object.values(agentPeerMap).some((id) => id !== DEFAULT_OWNER_PEER_ID &&
        (ownerPeerIds.has(id) || id === peerName))) {
        throw new Error("Honcho owner peer is already assigned to an agent.");
    }
    const peer = await honcho.peer(peerName);
    if (peerName !== DEFAULT_OWNER_PEER_ID && peer.metadata?.agentId) {
        throw new Error("Honcho owner peer is already assigned to an agent.");
    }
    if (!ownerPeerIds.has(peerName)) {
        const policy = await honcho.session(OWNER_POLICY_SESSION_ID);
        await policy.addPeers([peer, { observeMe: false, observeOthers: false }]);
        ownerPeerIds.add(peerName);
    }
    return { peer, ownerPeerIds };
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
        ownerPeerIds: new Set([DEFAULT_OWNER_PEER_ID, cfg.peerName]),
        refreshOwnerProtection,
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
        assertToolParticipantReadable,
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
        const owner = await resolveWorkspaceOwner(honcho, cfg.peerName, wsMeta);
        const agentPeerMap = { ...(wsMeta.agentPeerMap ?? {}) };
        const defaultId = resolveDefaultAgentId();
        let agentMapChanged = false;
        if (Object.keys(agentPeerMap).length === 0) {
            agentPeerMap[defaultId] = `agent-${defaultId}`;
            agentMapChanged = true;
        }
        else if (Object.values(agentPeerMap).includes(LEGACY_PEER_ID) && !agentPeerMap[defaultId]) {
            agentPeerMap[defaultId] = LEGACY_PEER_ID;
            agentMapChanged = true;
        }
        if (agentMapChanged) {
            await honcho.setMetadata({ ...wsMeta, agentPeerMap });
        }
        state.agentPeerMap = agentPeerMap;
        state.ownerPeerIds = owner.ownerPeerIds;
        ownerPeer = owner.peer;
        state.initialized = true;
    }
    async function refreshOwnerProtection() {
        const recorded = await readWorkspaceOwnerIds(honcho);
        state.ownerPeerIds = new Set([...state.ownerPeerIds, ...recorded]);
    }
    async function getParticipantPeer(channelPeerId) {
        await ensureInitialized();
        if (!channelPeerId)
            return ownerPeer;
        if (CLAWTALK_PEER_ID.test(channelPeerId) || CLAWTALK_PEER_ID.test(peersPersister.peers[channelPeerId] ?? "")) {
            throw new Error("ClawTalk device peers require an authenticated device context.");
        }
        // Known senders resolve via the peers file. Unknown senders auto-seed
        // per the persister's defaultUnknownPolicy: legacy installs merge into
        // the legacy owner peer; fresh installs derive a distinct peer from the sender ID.
        let peer = state.participantPeers.get(channelPeerId);
        if (peer)
            return peer;
        const wasInFile = channelPeerId in peersPersister.peers;
        const resolvedPeerId = resolveParticipantPeerId(channelPeerId, peersPersister);
        if (CLAWTALK_PEER_ID.test(resolvedPeerId)) {
            throw new Error("ClawTalk device peers require an authenticated device context.");
        }
        const autoSeeded = !wasInFile && !state.ownerPeerIds.has(resolvedPeerId);
        if (resolvedPeerId === cfg.peerName) {
            peer = ownerPeer;
        }
        else if (state.ownerPeerIds.has(resolvedPeerId)) {
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
        await ensureInitialized();
        await refreshOwnerProtection();
        if (requester.senderIsOwner === true && state.ownerPeerIds.size > 1)
            return ownerPeer;
        if (senderId) {
            const peer = await getParticipantPeer(senderId);
            if (!state.ownerPeerIds.has(peer.id) || requester.senderIsOwner === true)
                return peer;
            throw new Error("Honcho owner memory requires a verified owner.");
        }
        // Operator turns (TUI, Control UI) carry no sender id; capture files them
        // under the owner peer, so read them back from there.
        if (requester.senderIsOwner === true)
            return getParticipantPeer();
        throw new Error("Honcho requires a trusted requester identity.");
    }
    async function assertToolParticipantReadable(requester, peerId) {
        if (requester.senderIsOwner === true || isClawTalkSession(requester.sessionKey))
            return;
        await refreshOwnerProtection();
        if (state.ownerPeerIds.has(peerId))
            throw new Error("Honcho owner memory requires a verified owner.");
    }
    function isParticipantPeerId(peerId) {
        if (state.ownerPeerIds.has(peerId))
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
                if (state.ownerPeerIds.has(p.id))
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
