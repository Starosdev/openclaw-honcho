import { describe, expect, it, vi } from "vitest";
import {
  createHonchoMemoryRuntime,
  getHonchoMemorySearchManager,
  resolveHonchoMemoryBackendConfig,
} from "../runtime.js";
import type { PluginState } from "../state.js";
import { registerMemoryPassthrough } from "../tools/memory-passthrough.js";
import { buildSessionKey } from "../helpers.js";

it("keeps canonical memory tools within the trusted requester's messages", async () => {
  const state = createState();
  const sessionId = "session-1";
  const path = `sessions/${sessionId}.txt`;
  const participantMessage = { peerId: "alice", sessionId, content: "Alice's note" };
  const otherMessage = { peerId: "owner", sessionId, content: "Owner's note" };
  const session = {
    id: sessionId,
    context: vi.fn(async () => ({
      summary: { content: "Shared summary" },
      messages: [participantMessage, otherMessage],
    })),
  };
  const participant = {
    id: "alice",
    search: vi.fn(async () => [participantMessage, otherMessage]),
    sessions: vi.fn(async () => ({ items: [session] })),
  };
  state.resolveToolParticipantPeer = vi.fn(async ({ requesterSenderId, senderIsOwner }) => {
    if (senderIsOwner) return state.participantPeer!;
    if (requesterSenderId === "alice") return participant;
    throw new Error("Honcho requires a trusted requester identity.");
  }) as never;
  const factories = new Map<string, (ctx: Record<string, unknown>) => {
    execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
  }>();
  registerMemoryPassthrough({
    registerTool: (factory: never, opts: { name: string }) => factories.set(opts.name, factory),
  } as never, state);
  const common = { agentId: "main", sessionKey: "agent:main:discord:group:test" };
  const alice = { ...common, requesterSenderId: "alice" };
  const owner = { ...common, senderIsOwner: true };
  const search = factories.get("memory_search")!;
  const get = factories.get("memory_get")!;

  // Warm the transcript cache with an owner read before another participant reads it.
  expect((await get(owner).execute("owner", { path })).details).toMatchObject({
    text: expect.stringContaining("Summary for session one"),
  });
  const aliceSearch = (await search(alice).execute("search", { query: "note" })).details;
  expect(aliceSearch).toMatchObject({ results: [{ path, snippet: "Alice's note", startLine: 2 }] });
  const aliceRead = (await get(alice).execute("read", { path, from: 2, lines: 1 })).details;
  expect(aliceRead).toEqual({ path, text: "Alice's note" });
  const transcript = (await get(alice).execute("full", { path })).details;
  expect(transcript).toEqual({ path, text: "## User\nAlice's note\n" });
  expect((await get(alice).execute("unrelated", { path: "sessions/other-session.txt" })).details)
    .toMatchObject({ text: "", disabled: true });
  expect((await search(alice).execute("scoped", { query: "note", crossSessionSearch: false })).details)
    .toMatchObject({ results: [] });
  expect(participant.search).toHaveBeenLastCalledWith("note", {
    limit: 10, filters: { session_id: buildSessionKey(common) },
  });
  expect((await search(common).execute("unknown", { query: "note" })).details).toMatchObject({
    results: [], disabled: true,
  });
  expect((await get(common).execute("unknown", { path })).details).toMatchObject({
    text: "", disabled: true,
  });
});

type TestState = PluginState & {
  participantPeer: {
    id: string;
    search: ReturnType<typeof vi.fn>;
    sessions: ReturnType<typeof vi.fn>;
  } | null;
};

function createState(baseUrl = "https://api.honcho.dev", { crossSessionSearch = true }: { crossSessionSearch?: boolean } = {}): TestState {
  const contexts = new Map<string, { summary: { content: string }; messages: Array<Record<string, unknown>> }>([
    [
      "session-1",
      {
        summary: { content: "Summary for session one" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:00Z",
            content: "Need to remember this",
          },
          {
            peerId: "agent-main",
            createdAt: "2026-04-06T00:00:01Z",
            content: "Agent reply",
          },
        ],
      },
    ],
    [
      "session-1-child",
      {
        summary: { content: "Child summary" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:02Z",
            content: "Child transcript hit",
          },
        ],
      },
    ],
    [
      "other-session",
      {
        summary: { content: "Other summary" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:03Z",
            content: "Other result",
          },
        ],
      },
    ],
    [
      "session-2",
      {
        summary: { content: "Summary for session two" },
        messages: [
          {
            peerId: "owner",
            createdAt: "2026-04-06T00:00:04Z",
            content: "Alpha",
          },
          {
            peerId: "agent-main",
            createdAt: "2026-04-06T00:00:05Z",
            content: "Beta",
          },
        ],
      },
    ],
  ]);
  const searchResults = new Map<string, Array<Record<string, unknown>>>([
    [
      "session-1",
      [{ id: "msg-1", sessionId: "session-1", content: "Need to remember this" }],
    ],
    [
      "session-1-child",
      [{ id: "msg-2", sessionId: "session-1-child", content: "Child transcript hit" }],
    ],
    [
      "session-2",
      [{ id: "msg-3", sessionId: "session-2", content: "Beta\nextra" }],
    ],
    [
      "other-session",
      [{ id: "msg-4", sessionId: "other-session", content: "Other result" }],
    ],
  ]);

  const createSession = (sessionId: string) => ({
    id: sessionId,
    context: vi.fn(async () => contexts.get(sessionId)),
    search: vi.fn(async () => searchResults.get(sessionId) ?? []),
  });

  const childSession = createSession("session-1-child");

  const participantPeer = {
    id: "owner",
    search: vi.fn(async () => [
      { sessionId: "session-1", content: "Need to remember this" },
      { sessionId: "session-1-child", content: "Child transcript hit" },
      { sessionId: "other-session", content: "Other result" },
    ]),
    sessions: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield childSession;
      },
    })),
  };

  const state = {
    cfg: {
      workspaceId: "openclaw",
      baseUrl,
      noisePatterns: [],
      disableDefaultNoisePatterns: false,
      ownerObserveOthers: false,
      crossSessionSearch,
    },
    honcho: {
      session: vi.fn(async (sessionId: string) => createSession(sessionId)),
    } as never,
    participantPeer,
    participantPeers: new Map(),
    agentPeers: new Map(),
    agentPeerMap: {},
    turnStartIndex: new Map(),
    initialized: true,
    api: {} as never,
    ensureInitialized: vi.fn(async () => {}),
    getAgentPeer: vi.fn(async (agentId = "main") => ({ id: `agent-${agentId}` })),
    getParticipantPeer: vi.fn(async () => {
      if (!participantPeer) throw new Error("Honcho owner peer not initialized");
      return participantPeer;
    }),
    resolveSessionParticipantPeer: vi.fn(async () => {
      if (!state.participantPeer) throw new Error("Honcho owner peer not initialized");
      return state.participantPeer;
    }),
    isParticipantPeerId: vi.fn((peerId: string) => peerId === "owner"),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as TestState;
  return state;
}

describe("Honcho memory runtime", () => {
  it.each(["search", "read"] as const)("preserves the persisted capture checkpoint during session %s", async (operation) => {
    const state = createState("http://localhost:8000", { crossSessionSearch: false });
    const checkpoint = { lastSavedMessageId: "k:turn:user", lastSavedIndex: 3, participantSenderId: "alice" };
    let metadata: Record<string, unknown> = { ...checkpoint };
    const getSession = vi.mocked(state.honcho.session).getMockImplementation()!;
    vi.mocked(state.honcho.session).mockImplementation(async (key, options) => {
      if (options?.metadata) metadata = options.metadata;
      return getSession(key, options);
    });
    const { manager } = await getHonchoMemorySearchManager(state, { sessionKey: "session-1" });

    if (operation === "search") {
      expect(await manager.search("remember")).toHaveLength(1);
    } else {
      expect(await manager.readFile({ relPath: "sessions/session-1.txt" }))
        .toMatchObject({ text: expect.stringContaining("Need to remember this") });
    }
    expect(metadata).toEqual(checkpoint);
  });

  it("builds the unified memory capability runtime", async () => {
    const state = createState();
    const runtime = createHonchoMemoryRuntime(state);

    const { manager } = await runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "main",
    });

    expect(manager).toBeDefined();
    expect(
      runtime.resolveMemoryBackendConfig({
        cfg: {} as never,
        agentId: "main",
      }),
    ).toEqual({
      backend: "qmd",
      qmd: {},
    });
  });

  it("scopes a runtime-built manager per call via search opts.sessionKey", async () => {
    // Regression: the active-memory runtime creates a session-agnostic manager
    // and passes the session key per call. A false crossSessionSearch config
    // must still scope to the requested session, not fall back to cross-session.
    const state = createState("https://api.honcho.dev", { crossSessionSearch: false });
    const runtime = createHonchoMemoryRuntime(state);

    const { manager } = await runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "main",
    });

    // With a per-call sessionKey, scoped search must NOT hit the participant peer.
    const scoped = await manager.search("remember", { sessionKey: "session-1" });
    expect(state.participantPeer?.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(scoped[0]?.path).toBe("sessions/session-1.txt");

    // A per-call override still spans the participant peer's sessions.
    await manager.search("anything", { sessionKey: "session-1", crossSessionSearch: true });
    expect(state.participantPeer?.search as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("does not replace persisted session metadata during search or transcript reads", async () => {
    const state = createState("https://api.honcho.dev", { crossSessionSearch: false });
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    await manager.search("remember", { sessionKey: "session-1" });
    await manager.readFile({ relPath: "sessions/session-1.txt" });

    const sessionCalls = vi.mocked(state.honcho.session).mock.calls;
    expect(sessionCalls).toContainEqual(["session-1"]);
    expect(sessionCalls.every(([, options]) => options?.metadata === undefined)).toBe(true);
  });

  it("scopes search to the active session when crossSessionSearch is false", async () => {
    const state = createState("https://api.honcho.dev", { crossSessionSearch: false });

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });
    const results = await manager.search("remember", { maxResults: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("sessions/session-1.txt");
    expect(results[0]?.snippet).toBe("Need to remember this");
    expect(results[0]?.startLine).toBeGreaterThan(0);
    expect(results[0]?.endLine).toBeGreaterThanOrEqual(results[0]?.startLine ?? 0);
    // Session-scoped path uses honcho.session(...).search — participant peer is untouched.
    expect(state.participantPeer?.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("spans the participant peer's sessions when crossSessionSearch is true", async () => {
    const state = createState();

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    const results = await manager.search("anything");
    expect(state.participantPeer?.search as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    // Mock participant peer returns hits across session-1, session-1-child, other-session.
    const paths = new Set(results.map((r) => r.path));
    expect(paths.has("sessions/session-1.txt")).toBe(true);
    expect(paths.has("sessions/other-session.txt")).toBe(true);

    const file = await manager.readFile({
      relPath: "sessions/other-session.txt",
    });
    expect(file.path).toBe("sessions/other-session.txt");
    expect(file.text).toContain("Other summary");
  });

  it("reuses recent transcript fetches across repeated searches", async () => {
    const state = createState();
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    await manager.search("anything");
    const sessionCalls = (state.honcho.session as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    await manager.search("anything else");

    expect((state.honcho.session as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sessionCalls);
  });

  it("honors a per-call crossSessionSearch override", async () => {
    // Config default = false (scope to session); override = true (cross-session).
    const state = createState("https://api.honcho.dev", { crossSessionSearch: false });

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    await manager.search("q", { crossSessionSearch: true });
    expect(state.participantPeer?.search as ReturnType<typeof vi.fn>).toHaveBeenCalled();

    // Inverse: config true, per-call override false → session-scoped.
    const scopedState = createState();
    const { manager: scopedManager } = await getHonchoMemorySearchManager(scopedState, {
      agentId: "main",
      sessionKey: "session-1",
    });
    await scopedManager.search("q", { crossSessionSearch: false });
    expect(scopedState.participantPeer?.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("reads scoped transcript slices and resolves backend metadata", async () => {
    const state = createState("http://localhost:8000", { crossSessionSearch: false });

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });
    const file = await manager.readFile({
      relPath: "sessions/session-1.txt",
      from: 1,
      lines: 4,
    });

    expect(file.path).toBe("sessions/session-1.txt");
    expect(file.text).toContain("# Summary");
    expect(file.text).toContain("Summary for session one");
    expect(manager.status().provider).toBe("honcho-selfhosted");
    await expect(
      manager.readFile({
        relPath: "sessions/other-session.txt",
      }),
    ).rejects.toThrow(/outside the active session/);

    const backendConfig = resolveHonchoMemoryBackendConfig({ agentId: "main" });
    expect(backendConfig.backend).toBe("qmd");
    expect(backendConfig.qmd).toEqual({});
  });

  it("clamps fallback snippet ranges to the transcript length", async () => {
    const state = createState("https://api.honcho.dev", { crossSessionSearch: false });
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-2",
    });

    const [result] = await manager.search("beta", { maxResults: 5 });

    expect(result?.path).toBe("sessions/session-2.txt");
    expect(result?.startLine).toBe(8);
    expect(result?.endLine).toBe(9);
  });

  it("fails cleanly when the participant peer is unavailable after initialization", async () => {
    const state = createState();
    state.participantPeer = null;

    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    await expect(manager.search("remember")).rejects.toThrow(/owner peer not initialized/);
    await expect(
      manager.readFile({
        relPath: "sessions/session-1.txt",
      }),
    ).rejects.toThrow(/owner peer not initialized/);
  });
});
