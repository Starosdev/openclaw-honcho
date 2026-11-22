import { describe, expect, it, vi } from "vitest";
import { honchoConfigSchema } from "../config.js";
import type { PluginState } from "../state.js";
import { registerWorkspaceChatTool } from "../tools/workspace-chat.js";

type ToolContext = {
  senderIsOwner?: boolean;
  conversationReadOrigin?: string;
  sessionKey?: string;
  messageChannel?: string;
  requesterSenderId?: string;
};

const directOperator = {
  senderIsOwner: true,
  conversationReadOrigin: "direct-operator",
  sessionKey: "agent:main:main",
};

function fixture() {
  const chat = vi.fn(async () => "Alice and Bob mentioned the fixture.");
  const ensureInitialized = vi.fn(async () => undefined);
  type Tool = { execute(id: string, params: unknown): Promise<unknown> };
  let factory: (ctx: ToolContext) => Tool | null;
  registerWorkspaceChatTool({
    registerTool: (create: typeof factory) => { factory = create; },
  } as never, { honcho: { chat }, ensureInitialized } as unknown as PluginState);
  return { resolve: (ctx: ToolContext) => factory(ctx), chat, ensureInitialized };
}

describe("honcho_workspace_chat", () => {
  it("requires a boolean opt-in", () => {
    expect(honchoConfigSchema.parse({}).enableWorkspaceChat).toBe(false);
    expect(honchoConfigSchema.parse({ enableWorkspaceChat: "true" }).enableWorkspaceChat).toBe(false);
    expect(honchoConfigSchema.parse({ enableWorkspaceChat: true }).enableWorkspaceChat).toBe(true);
  });

  it("sends workspace queries and returns structured answers for direct operators", async () => {
    const { resolve, chat } = fixture();
    const tool = resolve(directOperator);
    const query = "Who mentioned the fixture?";
    const result = await tool?.execute("test", { query });
    expect(result).toMatchObject({
      details: { query, depth: "quick", answer: "Alice and Bob mentioned the fixture." },
    });
    expect(chat).toHaveBeenCalledWith(query, { reasoningLevel: "low" });
    await tool?.execute("test", { query, depth: "thorough" });
    expect(chat).toHaveBeenLastCalledWith(query, { reasoningLevel: "high" });
  });

  it.each([
    ["delegated owner", { ...directOperator, conversationReadOrigin: "delegated" }],
    ["missing origin", { ...directOperator, conversationReadOrigin: undefined }],
    ["unknown origin", { ...directOperator, conversationReadOrigin: "unknown" }],
    ["non-owner", { ...directOperator, senderIsOwner: false }],
    ["unidentified caller", { ...directOperator, senderIsOwner: undefined }],
    ["ClawTalk session", { ...directOperator, sessionKey: "agent:main:clawtalk-user:device:test" }],
    ["ClawTalk channel", { ...directOperator, messageChannel: "clawtalk" }],
    ["ClawTalk device", { ...directOperator, requesterSenderId: `gateway-device-${"a".repeat(64)}` }],
  ] as const)("denies %s before touching Honcho", (_label, ctx) => {
    const { resolve, chat, ensureInitialized } = fixture();
    expect(resolve(ctx)).toBeNull();
    expect(ensureInitialized).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("checks trusted origin again when a retained tool executes", async () => {
    const { resolve, chat, ensureInitialized } = fixture();
    const ctx = { ...directOperator };
    const tool = resolve(ctx);
    ctx.conversationReadOrigin = "delegated";
    await expect(tool?.execute("test", {
      query: "Workspace query", senderIsOwner: true, conversationReadOrigin: "direct-operator",
    })).rejects.toThrow("verified direct operator");
    expect(ensureInitialized).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});
