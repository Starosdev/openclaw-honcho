import { createRequire } from "node:module";
import { VERSION as gatewayVersion } from "openclaw/plugin-sdk/cli-runtime";
import { describe, expect, it, vi } from "vitest";
import { createPluginState, isManagedHonchoCloud } from "../state.js";

it("sends Gateway and plugin versions with JSON requests and multipart uploads", async () => {
  const requests: Headers[] = [];
  let uploaded = false;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    requests.push(headers);
    if (init.body instanceof FormData) {
      expect(headers.has("Content-Type")).toBe(false);
      uploaded = true;
      return Response.json([]);
    }
    return Response.json({ id: "fixture", metadata: {} });
  });
  try {
    const state = createPluginState({
      pluginConfig: { apiKey: "fixture-only", workspaceId: "fixture", baseUrl: "http://127.0.0.1:1" },
      logger: { warn() {}, info() {}, debug() {} },
    } as never);
    await state.honcho.getMetadata();
    const session = await state.honcho.session("fixture");
    await session.uploadFile({
      filename: "fixture.md", content: Buffer.from("Synthetic file"), content_type: "text/markdown",
    }, "owner");

    const { version } = createRequire(import.meta.url)("../package.json");
    expect(uploaded).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const headers of requests) {
      expect(headers.get("X-Honcho-Host")).toBe(`openclaw/${gatewayVersion} (${process.platform})`);
      expect(headers.get("X-Honcho-Plugin")).toBe(`openclaw-honcho/${version}`);
      expect(headers.has("X-Honcho-Agent-Model")).toBe(false);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("isManagedHonchoCloud", () => {
  it("recognizes the managed cloud host", () => {
    expect(isManagedHonchoCloud("https://api.honcho.dev")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isManagedHonchoCloud("https://API.HONCHO.DEV")).toBe(true);
  });

  it("treats custom self-hosted domains as not cloud", () => {
    expect(isManagedHonchoCloud("https://honcho.example.com")).toBe(false);
  });

  it("does not match look-alike domains", () => {
    expect(isManagedHonchoCloud("https://honcho.dev.evil.com")).toBe(false);
  });
});
