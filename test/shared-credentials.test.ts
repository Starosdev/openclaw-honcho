import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { honchoConfigSchema } from "../config.js";

describe("shared Honcho credentials", () => {
  const optIn = { enableSharedConfigCredentials: true };
  let home: string;
  let manifest: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "honcho-credentials-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("HONCHO_API_KEY", undefined);
    vi.stubEnv("HONCHO_BASE_URL", undefined);
    vi.stubEnv("HONCHO_WORKSPACE_ID", undefined);
    mkdirSync(join(home, ".honcho"));
    manifest = join(home, ".honcho", "config.json");
    writeFileSync(manifest, JSON.stringify({
      apiKey: "fake-root", environmentUrl: "https://root.invalid",
      hosts: { openclaw: { apiKey: "fake-shared", environmentUrl: "http://127.0.0.1:8000" } },
      workspaceId: "ignored",
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("requires opt-in and keeps plugin and environment credentials ahead of the file", () => {
    expect(honchoConfigSchema.parse({}).apiKey).toBeUndefined();
    vi.stubEnv("HONCHO_API_KEY", "fake-env");
    expect(honchoConfigSchema.parse(optIn)).toMatchObject({
      apiKey: "fake-env", baseUrl: "https://api.honcho.dev",
    });
    expect(honchoConfigSchema.parse({ ...optIn, apiKey: "fake-plugin" })).toMatchObject({
      apiKey: "fake-plugin", baseUrl: "https://api.honcho.dev",
    });
  });

  it("uses the OpenClaw key and endpoint together without importing the workspace", () => {
    expect(honchoConfigSchema.parse({ ...optIn, baseUrl: "http://127.0.0.1:8000/" })).toMatchObject({
      apiKey: "fake-shared", baseUrl: "http://127.0.0.1:8000", workspaceId: "openclaw",
    });
  });

  it("rejects explicit and environment endpoint conflicts", () => {
    expect(() => honchoConfigSchema.parse({ ...optIn, baseUrl: "http://127.0.0.1:8001" }))
      .toThrow("conflicts with the configured endpoint");
    vi.stubEnv("HONCHO_BASE_URL", "https://root.invalid");
    expect(() => honchoConfigSchema.parse(optIn)).toThrow("conflicts with the configured endpoint");
  });

  it("never combines an OpenClaw key with an endpoint from another scope", () => {
    writeFileSync(manifest, JSON.stringify({
      apiKey: "fake-root", environmentUrl: "https://root.invalid",
      hosts: { openclaw: { apiKey: "fake-shared" } },
    }));
    expect(() => honchoConfigSchema.parse(optIn)).toThrow("same configuration scope");
  });

  it("fails closed when the file is missing or names an invalid endpoint", () => {
    rmSync(manifest);
    expect(() => honchoConfigSchema.parse(optIn)).toThrow("Shared Honcho configuration");
    writeFileSync(manifest, JSON.stringify({ apiKey: "fake-root", environmentUrl: "https://root.invalid/path" }));
    expect(() => honchoConfigSchema.parse(optIn)).toThrow("valid HTTP(S) origin");
  });
});
