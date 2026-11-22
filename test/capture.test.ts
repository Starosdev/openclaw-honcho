import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NOISE_PATTERNS, honchoConfigSchema } from "../config.js";
import { flushMessages, registerCaptureHook } from "../hooks/capture.js";
import { buildSessionKey } from "../helpers.js";
import type { PluginState } from "../state.js";

const SENTINEL = "Conversation info (untrusted metadata):";

function metadataBlock(payload: Record<string, unknown>): string {
  return [SENTINEL, "```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

type CapturedMeta = Record<string, unknown>;
type PeerStub = { id: string; message: ReturnType<typeof vi.fn> };

type SessionStub = {
  metadata: CapturedMeta;
  setMetadata: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
  addPeers: ReturnType<typeof vi.fn>;
  addMessages: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
};

function createMockState(): { state: PluginState; session: SessionStub; ownerPeer: PeerStub } {
  const session: SessionStub = {
    metadata: {},
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (next: CapturedMeta) => {
      session.metadata = next;
    }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async () => undefined),
    messages: vi.fn(async ({ filters }: { filters: { metadata: CapturedMeta } }) => ({
      items: session.addMessages.mock.calls.flatMap(([messages]) => messages).filter(
        (message: { metadata?: CapturedMeta }) => Object.entries(filters.metadata).every(
          ([key, value]) => message.metadata?.[key] === value,
        ),
      ),
    })),
  };

  const agentPeer = { id: "agent-main", message: vi.fn((text: string) => ({ text })) };
  const ownerPeer = {
    id: "owner",
    message: vi.fn((text: string, options?: { metadata?: CapturedMeta }) => ({ text, ...options })),
  };

  const state = {
    cfg: {
      noisePatterns: DEFAULT_NOISE_PATTERNS,
      ownerObserveOthers: false,
      crossSessionSearch: true,
      workspaceId: "openclaw",
      baseUrl: "https://api.honcho.dev",
    },
    honcho: {
      // Mirrors real Honcho SDK: passing `metadata` on session() REPLACES the
      // persisted metadata. Tests that don't want this clobber must call
      // session() without a metadata argument.
      session: vi.fn(async (_key: string, opts?: { metadata?: CapturedMeta }) => {
        if (opts?.metadata) session.metadata = { ...opts.metadata };
        return session;
      }),
    },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => ownerPeer),
    getClawTalkParticipantPeer: vi.fn(async (senderId: string) => ({
      id: `clawtalk-${senderId}`,
      message: vi.fn((text: string, options?: { metadata?: CapturedMeta }) => ({
        text, peer_id: `clawtalk-${senderId}`, ...options,
      })),
    })),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session, ownerPeer };
}

function loggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("flushMessages metadata", () => {
  it("keeps the other sender's turns out of a shared DM capture and replay", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    const ctx = { sessionKey: "agent:main:main", agentId: "main", channel: "telegram", senderId: "222" };
    const user = (senderId: string, content: string) => ({
      role: "user", content, idempotencyKey: senderId + ":user",
      __openclaw: { senderId, transport: { channel: "telegram", messageId: "msg-" + senderId } },
    });
    const reply = (runId: string, content: string) => ({ role: "assistant", content, __openclaw: { runId } });
    const snapshot = [
      user("111", "Alice input"), reply("111", "Alice reply"),
      user("222", "Bob input"), reply("111", "Late Alice reply"), reply("222", "Bob reply"),
    ];
    state.turnStartIndex.set(buildSessionKey(ctx), 0);
    expect(await flushMessages(api, state, snapshot, ctx)).toBe(2);
    expect(session.addMessages).toHaveBeenCalledWith([
      { text: "Bob input", metadata: { openclawMessageId: "msg-222" } }, { text: "Bob reply" },
    ]);
    expect(session.metadata).toMatchObject({
      openclawSessionKey: "agent:main:main",
      conversationSessionKey: "agent:main:telegram:direct:222",
    });
    expect(await flushMessages(api, state, [snapshot[1], ...snapshot.slice(2)], ctx)).toBe(0);
    expect(await flushMessages(api, state, snapshot, { sessionKey: ctx.sessionKey }, true)).toBe(0);
    expect(session.addMessages).toHaveBeenCalledOnce();
    expect(state.honcho.session).toHaveBeenLastCalledWith(buildSessionKey(ctx));
  });

  it("stores human turns and sessions_send handoffs under separate peers", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    vi.mocked(state.getParticipantPeer).mockResolvedValue({
      id: "human-alice",
      message: (text: string) => ({ text, peer_id: "human-alice" }),
    } as never);
    vi.mocked(state.getAgentPeer).mockImplementation(async (id) => ({
      id: `agent-${id}`,
      message: (text: string) => ({ text, peer_id: `agent-${id}` }),
    }) as never);
    const handoff = { kind: "inter_session", sourceTool: "sessions_send" };
    const messages = [
      { role: "user", content: "Human message", __openclaw: { senderId: "alice" } },
      {
        role: "user", content: "Historical agent handoff", __openclaw: { senderId: "stale-human" },
        provenance: { ...handoff, sourceSessionKey: "agent:research:main" },
      },
      {
        role: "user", content: "Handoff without a valid source",
        provenance: { ...handoff, sourceSessionKey: "agent:invalid" },
      },
      { role: "user", content: "Current agent handoff", idempotencyKey: "handoff-run:user" },
      { role: "assistant", content: "Receiving agent reply" },
    ];
    await flushMessages(api, state, messages, {
      agentId: "main",
      sessionKey: "agent:main:discord:group:shared",
      runId: "handoff-run",
      inputProvenance: { ...handoff, sourceSessionKey: "agent:planner:main" },
    });

    expect(session.addMessages).toHaveBeenCalledWith([
      { text: "Human message", peer_id: "human-alice" },
      { text: "Historical agent handoff", peer_id: "agent-research" },
      { text: "Current agent handoff", peer_id: "agent-planner" },
      { text: "Receiving agent reply", peer_id: "agent-main" },
    ]);
    expect(session.metadata.participantSenderId).toBe("alice");
    expect(session.addPeers).toHaveBeenCalledWith(expect.arrayContaining([
      ["agent-research", { observeMe: true, observeOthers: false }],
      ["agent-planner", { observeMe: true, observeOthers: false }],
    ]));
  });

  it("keeps alternating senders separate when a flush includes an older turn", async () => {
    const { state, session, ownerPeer } = createMockState();
    const api = { logger: loggerStub() } as never;
    const group = { sessionKey: "agent:main:discord:group:shared", agentId: "main" };
    vi.mocked(state.getParticipantPeer).mockImplementation(async (senderId) => (
      senderId
        ? { id: senderId, message: (text: string) => ({ text, peer_id: senderId }) } as never
        : ownerPeer as never
    ));
    const messages = [
      {
        role: "user",
        content: `${metadataBlock({ sender_id: "U-bob" })}\n\nOlder Alice message`,
        __openclaw: { senderId: "U-alice" },
      },
      {
        role: "user",
        content: `${metadataBlock({ sender_id: "U-alice" })}\n\nCurrent Bob message`,
        idempotencyKey: "bob-run:user",
      },
    ];
    await flushMessages(api, state, messages, { ...group, senderId: "U-bob", runId: "bob-run" });
    expect(session.addMessages).toHaveBeenNthCalledWith(1, [
      { text: "Older Alice message", peer_id: "U-alice" },
      { text: "Current Bob message", peer_id: "U-bob" },
    ]);
    expect(session.metadata.participantSenderId).toBe("U-bob");

    await flushMessages(api, state, [
      ...messages,
      {
        role: "user",
        content: `${metadataBlock({ sender_id: "U-bob" })}\n\nCurrent Alice message`,
        __openclaw: { runId: "alice-run" },
      },
    ], { ...group, senderId: "U-alice", runId: "alice-run" });
    expect(session.addMessages).toHaveBeenNthCalledWith(2, [
      { text: "Current Alice message", peer_id: "U-alice" },
    ]);
    expect(session.metadata.participantSenderId).toBe("U-alice");
  });

  it("writes openclawSessionKey, sessionClass, messageProvider, and lastSessionId", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    const saved = await flushMessages(
      api,
      state,
      [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: "hi there", timestamp: 2 },
      ],
      {
        sessionKey: "agent:main:discord:dm:user-1",
        agentId: "main",
        sessionId: "uuid-current",
        messageProvider: "discord",
      },
    );

    expect(saved).toBe(2);
    expect(session.setMetadata).toHaveBeenCalled();
    const meta = session.metadata;
    expect(meta.openclawSessionKey).toBe("agent:main:discord:dm:user-1");
    expect(meta.sessionClass).toBe("chat");
    expect(meta.messageProvider).toBe("discord");
    expect(meta.lastSessionId).toBe("uuid-current");
    expect(meta.agentId).toBe("main");
    expect(session.addPeers).toHaveBeenCalledWith([
      ["owner", { observeMe: true, observeOthers: false }],
      ["agent-main", { observeMe: true, observeOthers: false }],
    ]);
  });

  it("records participantSenderId from the latest user message in the batch", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    await flushMessages(
      api,
      state,
      [
        {
          role: "user",
          content: `${metadataBlock({ sender_id: "U-alice" })}\n\nhi`,
          timestamp: 1,
        },
        {
          role: "user",
          content: `${metadataBlock({ sender_id: "U-bob" })}\n\nhello`,
          timestamp: 2,
        },
        { role: "assistant", content: "reply", timestamp: 3 },
      ],
      {
        sessionKey: "agent:main:discord:group:c-1",
        agentId: "main",
      },
    );

    expect(session.metadata.participantSenderId).toBe("U-bob");
  });

  it("classifies cron and subagent sessions in the metadata block", async () => {
    {
      const { state, session } = createMockState();
      const api = { logger: loggerStub() } as never;
      const cron = { sessionKey: "agent:main:cron:nightly:run:7", agentId: "main" };
      const messages = [{ role: "user", content: "tick", timestamp: 1 }];
      expect(await flushMessages(api, state, messages, cron)).toBe(0);
      expect(state.honcho.session).not.toHaveBeenCalled();
      state.cfg.captureSystemRuns = honchoConfigSchema.parse({ captureSystemRuns: true }).captureSystemRuns;
      await flushMessages(
        api,
        state,
        messages,
        cron,
      );
      expect(session.metadata.sessionClass).toBe("cron");
      expect(session.addMessages).toHaveBeenCalledOnce();
    }
    {
      const { state, session } = createMockState();
      const api = { logger: loggerStub() } as never;
      await flushMessages(
        api,
        state,
        [{ role: "user", content: "spawn", timestamp: 1 }],
        { sessionKey: "agent:main:subagent:research-1", agentId: "main" },
      );
      expect(session.metadata.sessionClass).toBe("subagent");
      expect(session.metadata.isSubagent).toBe(true);
    }
  });

  it("omits messageProvider and lastSessionId when not provided", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    await flushMessages(
      api,
      state,
      [{ role: "user", content: "hello", timestamp: 1 }],
      { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" },
    );

    expect(session.metadata).not.toHaveProperty("messageProvider");
    expect(session.metadata).not.toHaveProperty("lastSessionId");
  });
});

describe("registerCaptureHook source IDs", () => {
  it.each(["before_compaction", "before_reset"])("flushes both pending shared DM turns at %s without hook sender context", async (hook) => {
    const { state, session: alice } = createMockState();
    const { session: bob } = createMockState();
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
    const handlers = new Map<string, Handler>();
    registerCaptureHook({
      logger: loggerStub(),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as never, state);
    const ctx = { agentId: "main", sessionKey: "agent:main:main" };
    const aliceKey = buildSessionKey({ ...ctx, channel: "telegram", senderId: "111" });
    const bobKey = buildSessionKey({ ...ctx, channel: "telegram", senderId: "222" });
    vi.mocked(state.honcho.session).mockImplementation(async (key) => {
      expect([aliceKey, bobKey]).toContain(key);
      return (key === aliceKey ? alice : bob) as never;
    });
    state.turnStartIndex.set(aliceKey, 0);
    state.turnStartIndex.set(bobKey, 0);
    const messages = ["111", "222"].flatMap((senderId) => [
      { role: "user", content: "Input " + senderId, idempotencyKey: "channel-user:v1:" + senderId,
        __openclaw: { senderId, transport: { channel: "telegram" } } },
      { role: "assistant", content: "Reply " + senderId },
    ]);

    await handlers.get(hook)?.({ messages }, ctx);
    await handlers.get(hook)?.({ messages: messages.slice(1) }, ctx);

    expect(alice.addMessages.mock.calls).toEqual([[[{ text: "Input 111" }, { text: "Reply 111" }]]]);
    expect(bob.addMessages.mock.calls).toEqual([[[{ text: "Input 222" }, { text: "Reply 222" }]]]);
  });

  it.each(["before_compaction", "before_reset", "agent_end"])("preserves pending human turns at %s after a heartbeat", async (hook) => {
    const { state, session } = createMockState();
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
    const handlers = new Map<string, Handler>();
    registerCaptureHook({
      logger: loggerStub(),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as never, state);
    const ctx = { agentId: "main", sessionKey: "agent:main:discord:dm:user-1" };
    session.metadata.lastSavedIndex = 1;
    const messages = [
      { role: "user", content: "Previously saved human input" },
      { role: "user", content: "Pending human input", idempotencyKey: "human-1:user" },
      {
        role: "user", content: "Synthetic health poll", idempotencyKey: "heartbeat:user",
        provenance: { kind: "internal_system", sourceTool: "heartbeat" },
      },
      { role: "assistant", content: "Pending human reply", __openclaw: { runId: "human-1" } },
      { role: "assistant", content: "Synthetic health reply", __openclaw: { runId: "heartbeat" } },
    ];
    state.turnStartIndex.set(buildSessionKey(ctx), messages.length - 2);

    await handlers.get("agent_end")?.({ messages, success: true }, { ...ctx, runId: "heartbeat", trigger: "heartbeat" });
    expect(state.honcho.session).not.toHaveBeenCalled();

    await handlers.get(hook)?.({
      messages: [...messages, { role: "user", content: "Next human input" }],
      success: true,
    }, hook === "before_compaction" ? { ...ctx, runId: "heartbeat", trigger: "heartbeat" } : ctx);
    expect(session.addMessages).toHaveBeenCalledOnce();
    expect(session.addMessages).toHaveBeenCalledWith([
      { text: "Pending human input" },
      { text: "Pending human reply" },
      { text: "Next human input" },
    ]);
  });

  it("captures the exact ClawTalk user when the saved index belongs to an earlier message window", async () => {
    const { state, session } = createMockState();
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
    const handlers = new Map<string, Handler>();
    const api = {
      logger: loggerStub(),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as never;
    const senderId = `gateway-device-${"a".repeat(64)}`;
    const ctx = { agentId: "main", sessionKey: "agent:main:clawtalk-user:device:abc", runId: "run-2", senderId };
    const messages = [
      { role: "user", content: "current user turn", idempotencyKey: "run-2:user" },
      { role: "assistant", content: "current reply" },
    ];
    session.metadata.lastSavedIndex = 1;
    state.turnStartIndex.set(buildSessionKey(ctx), messages.length);
    registerCaptureHook(api, state);

    await Promise.all([
      handlers.get("before_compaction")?.({ messages }, ctx),
      handlers.get("agent_end")?.({ messages, success: true }, ctx),
    ]);

    expect(session.addMessages).toHaveBeenCalledOnce();
    expect(session.addMessages).toHaveBeenCalledWith([
      { text: "current user turn", peer_id: `clawtalk-${senderId}`,
        metadata: { openclawMessageId: "run-2", openclawRunId: "run-2" } },
      { text: "current reply" },
    ]);
    expect(session.metadata.participantSenderId).toBe(senderId);
  });

  it("persists the exact ClawTalk user turn after repeated prompt builds without an inbound hook", async () => {
    const { state, session } = createMockState();
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
    const handlers = new Map<string, Handler>();
    const api = {
      logger: loggerStub(),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as never;
    const ctx = { agentId: "main", sessionKey: "agent:main:clawtalk-user:device:abc", runId: "run-2", senderId: `gateway-device-${"a".repeat(64)}` };
    const messages = [
      { role: "user", content: "old turn", idempotencyKey: "run-1:user" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new turn", idempotencyKey: "run-2:user" },
      { role: "assistant", content: "new reply" },
    ];
    registerCaptureHook(api, state);
    state.turnStartIndex.set(buildSessionKey(ctx), messages.length);
    await handlers.get("agent_end")?.({ messages, success: true }, ctx);
    expect(session.addMessages).toHaveBeenCalledWith([
      { text: "new turn", peer_id: `clawtalk-${ctx.senderId}`,
        metadata: { openclawMessageId: "run-2", openclawRunId: "run-2" } },
      { text: "new reply" },
    ]);
    await handlers.get("agent_end")?.({ messages, success: true }, ctx);
    expect(session.addMessages).toHaveBeenCalledOnce();
  });

  it("binds inbound source ID to run before compaction flush", async () => {
    const { state, session, ownerPeer } = createMockState();
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
    const handlers = new Map<string, Handler>();
    const api = {
      logger: loggerStub(),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as never;
    const sessionKey = "agent:main:discord:dm:user-1";
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ];

    registerCaptureHook(api, state);
    handlers.get("message_received")?.(
      { messageId: "provider-message-1" },
      { messageId: "provider-message-1", sessionKey },
    );
    await handlers.get("before_prompt_build")?.(
      { prompt: "hello" },
      { runId: "run-1", sessionKey },
    );
    await handlers.get("before_compaction")?.(
      { messages },
      { agentId: "main", runId: "run-1", sessionKey },
    );

    expect(ownerPeer.message).toHaveBeenCalledWith("hello", {
      metadata: { openclawMessageId: "provider-message-1", openclawRunId: "run-1" },
    });
    expect(session.addMessages).toHaveBeenCalledOnce();

    await handlers.get("agent_end")?.(
      { messages, success: true },
      { agentId: "main", runId: "run-1", sessionKey },
    );

    expect(session.addMessages).toHaveBeenCalledOnce();
  });
});

describe("flushMessages batching", () => {
  it.each([true, false])("captures a shifted snapshot without skipping new messages (overlap: %s)", async (overlap) => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    const ctx = { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" };
    const covered = { role: "assistant", content: "Saved reply", timestamp: 2 };
    await flushMessages(api, state, [
      { role: "user", content: "Saved input", idempotencyKey: "old:user" },
      covered,
    ], ctx);
    state.turnStartIndex.set(buildSessionKey(ctx), 2);

    const next = { role: "user", content: "Unsaved input", idempotencyKey: "new:user" };
    const snapshot = overlap ? [covered, next] : [next];
    expect(await flushMessages(api, state, snapshot, ctx)).toBe(1);
    expect(session.addMessages).toHaveBeenNthCalledWith(2, [{ text: "Unsaved input" }]);
  });

  it("uses a legacy saved index for the first flush, then follows the identity checkpoint", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    const ctx = { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" };
    session.metadata.lastSavedIndex = 1;
    const first = { role: "user", content: "Legacy unsaved input", idempotencyKey: "first:user" };
    await flushMessages(api, state, [
      { role: "user", content: "Legacy saved input", idempotencyKey: "legacy:user" },
      first,
    ], ctx);
    expect(session.addMessages).toHaveBeenNthCalledWith(1, [{ text: "Legacy unsaved input" }]);

    await flushMessages(api, state, [
      { ...first, content: "Reformatted archived input" },
      { role: "user", content: "Input after upgrade", idempotencyKey: "second:user" },
    ], ctx);
    expect(session.addMessages).toHaveBeenNthCalledWith(2, [{ text: "Input after upgrade" }]);
  });

  it("does not skip an unsaved row between identical fallback identities", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    const ctx = { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" };
    const repeated = { role: "assistant", content: "Same reply", timestamp: 3 };
    await flushMessages(api, state, [
      { role: "user", content: "Previous input" },
      { role: "assistant", content: "Previous reply" },
      repeated,
    ], ctx);

    await flushMessages(api, state, [
      repeated,
      { role: "user", content: "Input between matching replies" },
      { ...repeated },
    ], ctx);
    expect(session.addMessages).toHaveBeenNthCalledWith(2, [
      { text: "Input between matching replies" },
      { text: "Same reply" },
    ]);
  });

  it.each([
    "agent:main:active-memory:0123456789ab",
    "agent:main:clawtalk-user:fixture:active-memory:0123456789ab",
  ])("skips recall capture with system-run capture enabled (%s)", async (sessionKey) => {
    const { state, session } = createMockState();
    state.cfg.captureSystemRuns = true;
    const messages = [
      { role: "user", content: "Synthetic recall prompt" },
      { role: "assistant", content: "Synthetic recall result" },
    ];
    const saved = await flushMessages({ logger: loggerStub() } as never, state, messages, {
      sessionKey, agentId: "main", runId: "active-memory-fixture", trigger: "manual",
    });

    expect(saved).toBe(0);
    expect(state.ensureInitialized).not.toHaveBeenCalled();
    expect(state.honcho.session).not.toHaveBeenCalled();
    expect(session.addMessages).not.toHaveBeenCalled();
  });

  it("keeps normal capture when a session key only resembles a recall key", async () => {
    const { state, session } = createMockState();
    const saved = await flushMessages({ logger: loggerStub() } as never, state,
      [{ role: "user", content: "Normal conversation input" }], {
        sessionKey: "agent:main:discord:group:active-memory:0123456789ab:thread:42",
        agentId: "main",
      });

    expect(saved).toBe(1);
    expect(session.addMessages).toHaveBeenCalledOnce();
  });

  it("captures a marked heartbeat when explicitly opted in", async () => {
    const { state, session } = createMockState();
    state.cfg.captureSystemRuns = honchoConfigSchema.parse({ captureSystemRuns: true }).captureSystemRuns;
    const input = { role: "user", content: "Health sweep", provenance: { kind: "internal_system" } };
    await flushMessages({ logger: loggerStub() } as never, state, [input], {
      sessionKey: "agent:main:main", trigger: "heartbeat",
    });
    expect(session.addMessages).toHaveBeenCalledWith([{ text: "Health sweep" }]);
  });

  it("filters legacy heartbeat boilerplate while preserving an unclassified reply", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    const saved = await flushMessages(
      api,
      state,
      [
        { role: "user", content: "[OpenClaw heartbeat poll]", timestamp: 1 },
        { role: "assistant", content: "Disk usage needs attention.", timestamp: 2 },
      ],
      { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" },
    );

    expect(saved).toBe(1);
    expect(session.addMessages).toHaveBeenCalledWith([{ text: "Disk usage needs attention." }]);
  });

  it("chunks addMessages into requests of at most 100 messages", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    // 116 messages exceeds Honcho's 100-per-request limit (HTTP 422).
    const messages = Array.from({ length: 116 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: i + 1,
    }));

    const saved = await flushMessages(api, state, messages, {
      sessionKey: "agent:main:discord:dm:user-1",
      agentId: "main",
    });

    expect(saved).toBe(116);
    expect(session.addMessages).toHaveBeenCalledTimes(2);
    expect(session.addMessages.mock.calls[0][0]).toHaveLength(100);
    expect(session.addMessages.mock.calls[1][0]).toHaveLength(16);
    // Watermark advances after each chunk: 100 after the first, then the full
    // message count after the last chunk.
    expect(session.setMetadata).toHaveBeenCalledTimes(2);
    expect(session.setMetadata.mock.calls[0][0].lastSavedIndex).toBe(100);
    expect(session.setMetadata.mock.calls[1][0].lastSavedIndex).toBe(116);
    // Each metadata commit happens after its chunk is persisted.
    expect(session.setMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      session.addMessages.mock.invocationCallOrder[0],
    );
    expect(session.metadata.lastSavedIndex).toBe(116);
  });

  it("re-flushing the same messages is a no-op (does not duplicate)", async () => {
    // Regression test: passing `metadata` to honcho.session() on an existing
    // session used to REPLACE persisted metadata, wiping `lastSavedIndex`
    // before it was read. The second flush then saw lastSavedIndex=0 and
    // re-sent every message, duplicating them in Honcho.
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    const messages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "hi", timestamp: 2 },
    ];
    const ctx = { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" };

    const first = await flushMessages(api, state, messages, ctx);
    expect(first).toBe(2);

    const second = await flushMessages(api, state, messages, ctx);
    expect(second).toBe(0);
    expect(session.addMessages).toHaveBeenCalledTimes(1);
  });

  it("does not re-send persisted chunks when a later chunk fails mid-batch", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    const messages = Array.from({ length: 116 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: i + 1,
    }));

    // First chunk persists; second chunk fails (e.g. transient network error).
    session.addMessages
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    await expect(
      flushMessages(api, state, messages, {
        sessionKey: "agent:main:discord:dm:user-1",
        agentId: "main",
      }),
    ).rejects.toThrow("boom");

    // The first chunk and its checkpoint survived. The retry starts with an
    // overlapping but shorter snapshot, where the old index is out of range.
    expect(session.addMessages).toHaveBeenCalledTimes(2);
    expect(session.setMetadata).toHaveBeenCalledTimes(1);
    expect(session.metadata.lastSavedIndex).toBe(100);
    expect(await flushMessages(api, state, messages.slice(90), {
      sessionKey: "agent:main:discord:dm:user-1",
      agentId: "main",
    })).toBe(16);
    expect(session.addMessages).toHaveBeenNthCalledWith(3, session.addMessages.mock.calls[1][0]);
  });
});
