import { describe, expect, it, vi } from "vitest";
import { honchoConfigSchema } from "../config.js";
import { sessionRecallOptions, peerRecallOptions, buildSessionKey } from "../helpers.js";
import { registerContextHook } from "../hooks/context.js";
import { registerAskTool } from "../tools/ask.js";
import type { PluginState } from "../state.js";

const ctx = { sessionKey: "agent:main:discord:dm:u1", agentId: "main" };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function mkState(recall: Record<string, unknown>) {
  let metadata: Record<string, unknown> = {};
  const session = {
    context: vi.fn(async (_options?: { peerTarget: { id: string } }) => ({
      peerCard: ["fact"],
      peerRepresentation: "rep",
      summary: undefined,
    })),
    getMetadata: vi.fn(async () => metadata),
    setMetadata: vi.fn(async (next: Record<string, unknown>) => { metadata = next; }),
  };
  const agentPeer = {
    id: "agent-main",
    chat: vi.fn(async () => "answer"),
    context: vi.fn(async () => ({ peerCard: ["workspace fact"] })),
    representation: vi.fn(async () => "scoped fact"),
  };
  const peer = { id: "owner" };
  const state = {
    ownerPeerIds: new Set(["owner"]),
    cfg: honchoConfigSchema.parse({ baseUrl: "http://x", recall }),
    honcho: { session: vi.fn(async (_key: string, options?: { metadata?: Record<string, unknown> }) => {
      if (options?.metadata) metadata = options.metadata;
      return session;
    }) },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async (senderId: string) => ({ id: senderId })),
    resolveSessionParticipantPeer: vi.fn(async () => peer),
    resolveToolParticipantPeer: vi.fn(async () => peer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;
  return { state, session, agentPeer };
}

/** Run the before_prompt_build hook and return the session.context() arguments. */
async function runContext(recall: Record<string, unknown>, metadata?: Record<string, unknown>) {
  const { state, session } = mkState(recall);
  if (metadata) await session.setMetadata(metadata);
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  registerContextHook(
    { on: (n: string, fn: never) => { if (n === "before_prompt_build") handler = fn; }, logger } as never,
    state,
  );
  const result = await handler?.({ prompt: "a real prompt", messages: [] }, ctx);
  return { args: session.context.mock.calls[0]?.[0] ?? {}, result, session };
}

async function contextArgs(recall: Record<string, unknown>) {
  return (await runContext(recall)).args;
}

/** Run honcho_ask and return the peer.chat() options. */
async function askArgs(
  recall: Record<string, unknown>,
  toolCtx: { sessionKey: string; agentId?: string } = ctx,
  defaultAgentId = "main",
) {
  const { state, agentPeer } = mkState(recall);
  vi.mocked(state.resolveDefaultAgentId).mockReturnValue(defaultAgentId);
  let tool: any;
  registerAskTool({ registerTool: (factory: any) => { tool = factory(toolCtx); } } as never, state);
  await tool.execute("id", { query: "q" });
  return agentPeer.chat.mock.calls[0]?.[1] ?? {};
}

describe("recall boundaries are applied per path", () => {
  it("withholds custom and historical owner recall without verified owner context", async () => {
    const { state, session } = mkState({});
    state.ownerPeerIds = new Set(["owner", "vega-owner"]);
    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (n: string, fn: never) => { if (n === "before_prompt_build") handler = fn; }, logger } as never,
      state,
    );
    const prompt = { prompt: "ordinary input", messages: [] };
    for (const senderId of ["owner", "vega-owner"]) {
      expect(await handler?.(prompt, { ...ctx, senderId })).toBeUndefined();
    }
    expect(session.context).not.toHaveBeenCalled();
    await handler?.(prompt, { ...ctx, senderId: "alice" });
    expect(session.context).toHaveBeenCalledWith(expect.objectContaining({
      peerTarget: { id: "alice" }, summary: false,
    }));
  });

  it("records the shared DM capture boundary for a short prompt without recalling", async () => {
    const { state } = mkState({});
    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (n: string, fn: never) => { if (n === "before_prompt_build") handler = fn; }, logger } as never,
      state,
    );
    const dm = { agentId: "main", sessionKey: "agent:main:main", channel: "telegram", senderId: "222" };

    await handler?.({ prompt: "hi", messages: [] }, dm);

    expect(state.turnStartIndex.get(buildSessionKey(dm))).toBe(0);
    expect(state.honcho.session).not.toHaveBeenCalled();
  });

  it("preserves the persisted capture checkpoint during prompt recall", async () => {
    const checkpoint = {
      lastSavedMessageId: "k:turn:user",
      lastSavedIndex: 3,
      openclawSessionKey: ctx.sessionKey,
      participantSenderId: "u1",
    };
    const { session } = await runContext({ automatic: "session" }, { ...checkpoint });

    expect(session.context).toHaveBeenCalledOnce();
    expect(await session.getMetadata()).toEqual(checkpoint);
  });

  it.each([false, true])("only opens Honcho for system recall when opted in (%s)", async (optIn) => {
    const { state } = mkState({});
    state.cfg.captureSystemRuns = honchoConfigSchema.parse(optIn ? { captureSystemRuns: true } : {}).captureSystemRuns;
    let handler: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
    registerContextHook({
      on: (name: string, fn: never) => { if (name === "before_prompt_build") handler = fn; },
      logger,
    } as never, state);
    const event = { prompt: "Synthetic health poll", messages: [] };
    await handler?.(event, { ...ctx, trigger: "heartbeat" });
    await handler?.(event, { ...ctx, sessionKey: "agent:main:cron:nightly:run:7" });
    expect(state.honcho.session).toHaveBeenCalledTimes(optIn ? 2 : 0);
  });

  it("recalls for alternating current senders in a shared group session", async () => {
    const { state, session } = mkState({});
    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (name: string, fn: never) => { if (name === "before_prompt_build") handler = fn; }, logger } as never,
      state,
    );
    session.context.mockImplementation(async (options) => ({
      peerCard: [],
      peerRepresentation: `memory for ${options?.peerTarget.id}`,
      summary: undefined,
    }));
    const group = { ...ctx, sessionKey: "agent:main:discord:group:shared" };
    const event = (previousSenderId: string) => ({
      prompt: [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ sender_id: previousSenderId }),
        "```",
        "Normal group message",
      ].join("\n"),
      messages: [],
    });
    for (const [senderId, previousSenderId] of [["alice", "bob"], ["bob", "alice"], ["alice", "bob"]]) {
      const result = await handler?.(event(previousSenderId), { ...group, senderId });
      expect(result).toEqual({ appendSystemContext: expect.stringContaining(`memory for ${senderId}`) });
      expect(result).toEqual({ appendSystemContext: expect.not.stringContaining(`memory for ${previousSenderId}`) });
    }
    await expect(handler?.(event("bob"), group)).resolves.toEqual({
      appendSystemContext: expect.stringContaining("memory for bob"),
    });
  });

  it("reaches across the workspace by default, which is what a workspace is for", async () => {
    const args = await contextArgs({});
    expect(args.limitToSession).toBeUndefined();
    expect(args.scope).toBeUndefined();
    expect(args.peerPerspective).toBeDefined();
    expect((await askArgs({})).session).toBeUndefined();
  });

  it("narrows to the session when asked", async () => {
    expect((await contextArgs({ automatic: "session" })).limitToSession).toBe(true);
    expect((await askArgs({ ask: "session" })).session).toBe(buildSessionKey(ctx));
  });

  it("omits the workspace card when an older server returns it in session mode", async () => {
    const { result } = await runContext({ automatic: "session" });
    expect(result).toEqual({ appendSystemContext: expect.stringContaining("User context:\nrep") });
    expect(result).toEqual({ appendSystemContext: expect.not.stringContaining("Key facts:") });
  });

  it("asks against the capture session when the tool context omits agentId", async () => {
    const toolCtx = { sessionKey: "agent:vega:discord:dm:u1" };
    const args = await askArgs({ ask: "session" }, toolCtx, "vega");
    expect(args.session).toBe(buildSessionKey({ ...toolCtx, agentId: "vega" }));
  });

  it.each([
    [{}, "workspace fact", undefined],
    [{ automatic: "session" }, "scoped fact", "session"],
    [{ automatic: "scope", scopeName: "client-a" }, "scoped fact", "scope"],
  ] as const)("uses peer recall for subagent prompts (%j)", async (recall, fact, boundary) => {
    const { state, agentPeer } = mkState(recall);
    const child = { ...ctx, sessionKey: "agent:main:subagent:child" };
    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook({ on: (_name: string, fn: never) => { handler = fn; }, logger } as never, state);

    const result = await handler?.({ prompt: "a real prompt", messages: [] }, child);

    expect(result).toEqual({ appendSystemContext: expect.stringContaining(fact) });
    expect(state.honcho.session).not.toHaveBeenCalled();
    if (boundary) {
      expect(agentPeer.context).not.toHaveBeenCalled();
      expect(agentPeer.representation).toHaveBeenCalledWith(expect.objectContaining(
        boundary === "session" ? { session: buildSessionKey(child) } : { scope: "client-a" },
      ));
    }
  });

  it("uses the scope and drops peerPerspective, which the SDK rejects alongside scope", async () => {
    const args = await contextArgs({ automatic: "scope", scopeName: "client-a" });
    expect(args.scope).toBe("client-a");
    expect(args.peerPerspective).toBeUndefined();
    expect(args.limitToSession).toBeUndefined();
    expect((await askArgs({ ask: "scope", scopeName: "client-a" })).scope).toBe("client-a");
  });

  it("falls back to the session when scope is selected without a name", () => {
    // Narrower than intended beats wider than intended.
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://x", recall: { automatic: "scope" } });
    expect(cfg.recall.automatic).toBe("session");
  });

  it("ignores unknown values rather than passing them through", () => {
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://x", recall: { automatic: "everything" } });
    expect(cfg.recall.automatic).toBe("workspace");
  });
});

describe("recall option builders", () => {
  it("maps each boundary to the right SDK options", () => {
    expect(sessionRecallOptions("session")).toEqual({ limitToSession: true });
    expect(sessionRecallOptions("scope", "s")).toEqual({ scope: "s" });
    expect(sessionRecallOptions("workspace")).toEqual({});
    expect(peerRecallOptions("session", undefined, "sid")).toEqual({ session: "sid" });
    expect(peerRecallOptions("scope", "s", "sid")).toEqual({ scope: "s" });
    expect(peerRecallOptions("workspace", undefined, "sid")).toEqual({});
  });
});

describe("no configured path is left unwired", () => {
  it("every key the config exposes is read by a call site", () => {
    // A setting that parses but is never applied is worse than no setting: it
    // reads as a guarantee and silently does nothing. `tools` was removed for
    // exactly that reason — peer.card() takes no scoping and peer.search()
    // takes only filters, so it could not cover honcho_context or
    // honcho_search_messages.
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://x" });
    const paths = Object.keys(cfg.recall).filter((k) => k !== "scopeName");
    expect(paths.sort()).toEqual(["ask", "automatic"]);
  });
});
