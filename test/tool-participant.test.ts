import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginState, type PluginState } from "../state.js";
import { registerAskTool } from "../tools/ask.js";
import { registerContextTool } from "../tools/context.js";
import { registerMessageSearchTool } from "../tools/message-search.js";
import { registerSearchTool } from "../tools/search.js";
import { registerSessionTool } from "../tools/session.js";

/**
 * Real plugin state over a fake Honcho, so participant resolution runs the
 * same code the gateway does.
 */
const fake = vi.hoisted(() => ({ honcho: undefined as unknown }));
vi.mock("@honcho-ai/sdk", () => ({ Honcho: class { constructor() { return fake.honcho; } } }));

const GROUP_KEY = "agent:main:telegram:group:-100123456";

function makePeer(id: string) {
  const peer = {
    id,
    metadata: { channelPeerId: id },
    card: vi.fn(async () => ["fact"]),
    representation: vi.fn(async () => "rep"),
    search: vi.fn(async () => []),
    chat: vi.fn(async () => "answer"),
    getMetadata: vi.fn(async () => peer.metadata),
    setMetadata: vi.fn(async () => undefined),
  };
  return peer;
}

/** A group where Bob (222) spoke last, so session metadata names him. */
function setup(defaultUnknownPolicy: "per-sender" | "owner" = "per-sender", peerName?: string) {
  const peers = new Map([makePeer("111"), makePeer("222")].map((p) => [p.id, p]));
  const session = {
    getMetadata: vi.fn(async () => ({ participantSenderId: "222" })),
    setMetadata: vi.fn(async () => undefined),
    context: vi.fn(async () => ({
      summary: { content: "shared summary" },
      peerCard: undefined,
      peerRepresentation: undefined,
      messages: [{ peerId: "111", content: "Alice row" }, { peerId: "222", content: "Bob row" }],
    })),
  };
  let wsMeta: Record<string, unknown> = {};
  fake.honcho = {
    http: { upload: vi.fn() },
    getMetadata: vi.fn(async () => wsMeta),
    setMetadata: vi.fn(async (m: Record<string, unknown>) => { wsMeta = m; }),
    peer: vi.fn(async (id: string) => {
      let p = peers.get(id);
      if (!p) peers.set(id, (p = makePeer(id)));
      return p;
    }),
    peers: vi.fn(async () => [...peers.values()]),
    session: vi.fn(async () => session),
    search: vi.fn(async () => []),
  };
  writeFileSync(
    process.env.OPENCLAW_HONCHO_PEERS_FILE!,
    JSON.stringify({ version: 1, defaultUnknownPolicy, peers: {
      "111": "111", "222": "222", "333": peerName ?? "owner", "444": "owner",
      ...(peerName ? { [peerName]: "111" } : {}),
    } }),
  );
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createState = (name?: string) =>
    createPluginState({ pluginConfig: { baseUrl: "http://x", peerName: name }, logger, config: {} } as never);
  return { state: createState(peerName), createState, session, peers };
}

function tool(register: (api: never, state: PluginState) => void, state: PluginState, toolCtx: Record<string, unknown>) {
  let t: any;
  register({
    logger: { warn: vi.fn() },
    registerTool: (factory: (ctx: unknown) => unknown) => { t = factory(toolCtx); },
  } as never, state);
  return t as { execute: (id: string, params: Record<string, unknown>) => Promise<any> };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "oc-honcho-peers-"));
  process.env.OPENCLAW_HONCHO_PEERS_FILE = path.join(dir, "openclaw-peers.json");
});
afterEach(() => {
  delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("tools read the requester's own memory", () => {
  it("resolves distinct ClawTalk device peers even with the legacy owner fallback configured", async () => {
    const { state, peers } = setup("owner");
    await state.ensureInitialized();
    const ctx = { sessionKey: "agent:main:clawtalk-user:test" };
    const first = `gateway-device-${"a".repeat(64)}`;
    const second = `gateway-device-${"b".repeat(64)}`;
    await tool(registerMessageSearchTool, state, { ...ctx, requesterSenderId: first })
      .execute("first", { query: "q" });
    expect(peers.get(`clawtalk-${first}`)?.search).toHaveBeenCalledOnce();
    await tool(registerMessageSearchTool, state, { ...ctx, requesterSenderId: second })
      .execute("second", { query: "q" });
    expect(peers.get(`clawtalk-${first}`)?.search).toHaveBeenCalledOnce();
    expect(peers.get(`clawtalk-${second}`)?.search).toHaveBeenCalledOnce();
    expect(peers.get("owner")?.search).not.toHaveBeenCalled();
    await expect(state.getParticipantPeer(`clawtalk-${first}`))
      .rejects.toThrow("authenticated device context");
    await expect(tool(registerMessageSearchTool, state, { ...ctx, requesterSenderId: "openclaw-ios" })
      .execute("unknown", { query: "q" })).rejects.toThrow("verified ClawTalk device");
  });

  it("every tool targets the sender of the current message, not whoever spoke last", async () => {
    const { state, session, peers } = setup();
    const aliceTurn = { sessionKey: GROUP_KEY, agentId: "main", requesterSenderId: "111" };

    const result = await tool(registerSessionTool, state, aliceTurn).execute("id", {});
    expect(result.content[0].text).toContain("Alice row");
    expect(result.content[0].text).not.toMatch(/Bob row|shared summary/);
    expect(result.details).toMatchObject({
      summary: null,
      messages: [{ speaker: "User", createdAt: null, content: "Alice row" }],
    });
    const ask = await tool(registerAskTool, state, aliceTurn).execute("id", { query: "q" });
    expect(ask.details.answer).toBe("answer");
    const context = await tool(registerContextTool, state, aliceTurn).execute("id", {});
    expect(context.details.facts).toEqual(["fact"]);
    const conclusions = await tool(registerSearchTool, state, aliceTurn).execute("id", { query: "hike" });
    expect(conclusions.details.representation).toBe("rep");
    const search = tool(registerMessageSearchTool, state, aliceTurn);
    await search.execute("id", { query: "hike" });
    await expect(search.execute("id", { query: "hike", from: "all" })).rejects.toThrow("verified owner");

    const alice = peers.get("111")!;
    const bob = peers.get("222")!;
    expect(session.context.mock.calls[0][0].peerTarget.id).toBe("111");
    expect(peers.get("agent-main")!.chat.mock.calls[0][1].target.id).toBe("111");
    expect(alice.card).toHaveBeenCalled();
    expect(alice.representation).toHaveBeenCalled();
    expect(alice.search).toHaveBeenCalled();
    expect(bob.card).not.toHaveBeenCalled();
    expect(bob.representation).not.toHaveBeenCalled();
    expect(bob.search).not.toHaveBeenCalled();
    expect([...peers.keys()].sort()).toEqual(["111", "222", "agent-main", "owner"]);
  });

  it.each([undefined, "vega-owner"])("allows verified owner reads and rejects non-owner aliases (peerName %s)", async (peerName) => {
    const { state, session } = setup("owner", peerName);
    const history = tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main", senderIsOwner: true });
    const result = await history.execute("id", {});
    expect(session.context.mock.calls[0][0].peerTarget.id).toBe(peerName ?? "owner");
    expect(result.details).toMatchObject({ summary: "shared summary", messageCount: 2 });
    const omitted = await history.execute("id", { includeSummary: false, includeMessages: false });
    expect(omitted.details).toMatchObject({ summary: null, messages: [] });
    for (const requesterSenderId of ["333", "444", "555"]) {
      const denied = tool(registerSessionTool, state, { sessionKey: GROUP_KEY, requesterSenderId });
      await expect(denied.execute("id", {})).rejects.toThrow("verified owner");
    }
    expect(session.context).toHaveBeenCalledTimes(2);

    if (peerName) {
      const mapped = tool(registerSessionTool, state, { sessionKey: GROUP_KEY, requesterSenderId: peerName });
      await mapped.execute("id", {});
      expect(session.context.mock.calls.at(-1)?.[0].peerTarget.id).toBe("111");
    }
  });

  it("denies requester reads without trusted identity", async () => {
    const { state, session } = setup();
    const t = tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main" });
    await expect(t.execute("id", { about: "222" })).rejects.toThrow("trusted requester identity");
    expect(session.context).not.toHaveBeenCalled();
  });

  it("rejects a custom owner peer already mapped to an agent", async () => {
    const { state, peers } = setup("per-sender", "existing-agent-peer");
    await state.honcho.setMetadata({ agentPeerMap: { main: "existing-agent-peer" } });

    await expect(state.ensureInitialized()).rejects.toThrow("already assigned to an agent");
    expect(peers.has("existing-agent-peer")).toBe(false);
  });

  it("denies non-owner aliases to the original custom peer after rollback or rotation", async () => {
    const { state, createState, session } = setup("owner", "vega-owner");
    await state.ensureInitialized();
    expect((await state.getParticipantPeer("555")).id).toBe("owner");

    for (const peerName of [undefined, "rotated-owner"]) {
      const restarted = createState(peerName);
      const history = tool(registerSessionTool, restarted, {
        sessionKey: GROUP_KEY, requesterSenderId: "333",
      });
      await expect(history.execute("id", {})).rejects.toThrow("verified owner");
    }
    expect(session.context).not.toHaveBeenCalled();
  });
});
