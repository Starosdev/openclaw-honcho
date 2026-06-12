import { describe, expect, it } from "vitest";
import { buildSessionKey } from "../helpers.js";

describe("buildSessionKey", () => {
  it("caps long sanitized webchat session ids to Honcho's 100-char limit", () => {
    const sessionKey =
      "agent:vega:monica:clawtalk:user:b7fec829f53a5dc6706ed26bd229f501a2d7669838c116ed6396ad75da456f71:d5c3716f";

    const id = buildSessionKey({
      sessionKey,
      messageProvider: "webchat",
    });

    expect(id.length).toBe(100);
    expect(id.startsWith("agent-vega-monica-clawtalk-user-")).toBe(true);
    expect(id).toMatch(/[0-9a-f]{12}$/);
  });

  it("keeps shorter ids unchanged", () => {
    const id = buildSessionKey({
      sessionKey: "agent:main:discord:dm:user-1",
      messageProvider: "discord",
    });

    expect(id).toBe("agent-main-discord-dm-user-1-discord");
  });

  it("returns the same id for the same long session key", () => {
    const ctx = {
      sessionKey:
        "agent:vega:monica:clawtalk:user:b7fec829f53a5dc6706ed26bd229f501a2d7669838c116ed6396ad75da456f71:d5c3716f",
      messageProvider: "webchat",
    };

    expect(buildSessionKey(ctx)).toBe(buildSessionKey(ctx));
  });
});
