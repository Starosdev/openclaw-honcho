import { describe, expect, it } from "vitest";
import { honchoConfigSchema } from "./config.js";

describe("honchoConfigSchema.peerMappings", () => {
  it("defaults to an empty object when absent", () => {
    const cfg = honchoConfigSchema.parse({});
    expect(cfg.peerMappings).toEqual({});
  });

  it("passes through valid string→string entries", () => {
    const cfg = honchoConfigSchema.parse({
      peerMappings: {
        U01ZB5DG019: "abigail",
        "telegram-8461078551": "abigail",
      },
    });
    expect(cfg.peerMappings).toEqual({
      U01ZB5DG019: "abigail",
      "telegram-8461078551": "abigail",
    });
  });

  it("trims keys and values", () => {
    const cfg = honchoConfigSchema.parse({
      peerMappings: { "  U-foo  ": "  alice  " },
    });
    expect(cfg.peerMappings).toEqual({ "U-foo": "alice" });
  });

  it("drops malformed entries (non-string values, empty strings)", () => {
    const cfg = honchoConfigSchema.parse({
      peerMappings: {
        good: "peer-ok",
        empty: "",
        whitespace: "   ",
        numeric: 42,
        nullish: null,
        "": "orphaned-key",
      },
    });
    expect(cfg.peerMappings).toEqual({ good: "peer-ok" });
  });

  it("ignores non-object peerMappings values", () => {
    expect(honchoConfigSchema.parse({ peerMappings: "nope" }).peerMappings).toEqual({});
    expect(honchoConfigSchema.parse({ peerMappings: [] }).peerMappings).toEqual({});
    expect(honchoConfigSchema.parse({ peerMappings: null }).peerMappings).toEqual({});
  });
});
