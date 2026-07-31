/**
 * Sender_id → Honcho peer_id map, persisted at ~/.honcho/openclaw-peers.json.
 *
 * Plugin auto-seeds unknown senders per `defaultUnknownPolicy`:
 *   "owner"      → strangers merge into the OWNER_ID peer (legacy contract).
 *   "per-sender" → each stranger gets a peer derived from its sender_id
 *                  (sanitized + truncated to satisfy Honcho's RESOURCE_NAME_PATTERN).
 * Fresh installs (file missing) default to "per-sender"; pre-existing files
 * (no policy field) keep "owner" so legacy users see no behavior change.
 *
 * Restart reloads from disk. Flush merges disk before write (disk wins conflicts)
 * so concurrent file edits are not overwritten. OPENCLAW_HONCHO_PEERS_FILE overrides path.
 */
export declare const PEERS_FILE_VERSION = 1;
export type DefaultUnknownPolicy = "owner" | "per-sender";
export type PeersFile = {
    version: typeof PEERS_FILE_VERSION;
    defaultUnknownPolicy: DefaultUnknownPolicy;
    peers: Record<string, string>;
};
export declare function resolvePeersFilePath(): string;
/** Read the peers file. Missing → per-sender (fresh install); anything else → owner (legacy). */
export declare function loadPeersFile(filePath: string): Promise<PeersFile>;
export declare function loadPeersFileSync(filePath: string): PeersFile;
/**
 * Resolve an inbound sender_id to a Honcho peer ID. Known senders return their
 * mapping; unknown senders auto-seed under the persister's policy and enqueue
 * for persistence. Per-sender peer IDs are derived from the sender_id —
 * sanitized to satisfy Honcho's RESOURCE_NAME_PATTERN and truncated to its
 * 100-char limit.
 */
export declare function resolveParticipantPeerId(senderId: string, persister: PeersPersister, ownerPeerId?: string): string;
export type PeersPersisterOptions = {
    /** Flush debounce window in milliseconds. Default 1000. */
    debounceMs?: number;
};
/**
 * Debounced, serialized writer for the peers file.
 *
 * enqueue() is synchronous — it mutates the in-memory map and schedules a
 * background flush. Multiple enqueues within the debounce window coalesce
 * into a single write. Flushes are chained via a single promise so writes
 * cannot interleave.
 *
 * Each flush() re-reads the file and merges `{ ...memory, ...disk }` so disk
 * wins on conflicting sender_ids; keys only on disk or only in memory are
 * kept. enqueue() never overwrites an existing mapping.
 */
export declare class PeersPersister {
    readonly peers: Record<string, string>;
    readonly filePath: string;
    defaultUnknownPolicy: DefaultUnknownPolicy;
    private readonly debounceMs;
    private dirty;
    private timer;
    private chain;
    constructor(filePath: string, initial: PeersFile, opts?: PeersPersisterOptions);
    /** Record a sender_id → peer_id mapping if absent. Schedules a debounced flush. */
    enqueue(senderId: string, peerId?: string): void;
    /** Flush any pending changes immediately. Safe to call concurrently with enqueue(). */
    flushNow(): Promise<void>;
    private flush;
}
