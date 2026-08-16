import { describe, expect, it } from "vitest";
import {
  buildDegradedContext,
  formatDegradedContext,
  isConnectionFailure,
  readLocalEpisodes,
  type DegradedFallbackConfig,
} from "../degraded.js";

const config: DegradedFallbackConfig = {
  enabled: true,
  memoryProcessFile: "/opt/openclaw/vega-data/vega-memory-process.json",
  maxEpisodes: 2,
};

function fileWith(payload: unknown): (path: string, encoding: "utf8") => Promise<string> {
  return async () => JSON.stringify(payload);
}

describe("degraded memory rail", () => {
  it("treats an unreachable service as degradable", () => {
    expect(isConnectionFailure(Object.assign(new Error("fetch failed"), { name: "TypeError" }))).toBe(
      true,
    );
    expect(isConnectionFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(
      isConnectionFailure(
        Object.assign(new Error("Connection error."), { name: "APIConnectionError" }),
      ),
    ).toBe(true);
    // Reported through a cause chain, which is how undici surfaces it.
    expect(
      isConnectionFailure(
        new Error("request failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }),
      ),
    ).toBe(true);
  });

  it("never degrades on an answered request, 422 included", () => {
    expect(isConnectionFailure(Object.assign(new Error("Unprocessable Entity"), { status: 422 }))).toBe(
      false,
    );
    expect(isConnectionFailure(Object.assign(new Error("Server Error"), { status: 500 }))).toBe(false);
    expect(isConnectionFailure(Object.assign(new Error("nope"), { statusCode: 404 }))).toBe(false);
    expect(isConnectionFailure(new Error("something else"))).toBe(false);
    expect(isConnectionFailure(undefined)).toBe(false);
  });

  it("reads the newest episodes up to the cap and skips empty summaries", async () => {
    const episodes = await readLocalEpisodes(
      config,
      fileWith({
        episodes: [
          { at: "2026-08-01T00:00:00Z", summary: "oldest" },
          { at: "2026-08-02T00:00:00Z", summary: "  " },
          { at: "2026-08-03T00:00:00Z", summary: "middle", theme_id: "ml" },
          { at: "2026-08-04T00:00:00Z", summary: "newest" },
        ],
      }),
    );
    expect(episodes.map((episode) => episode.summary)).toEqual(["newest", "middle"]);
    expect(episodes[1]?.themeId).toBe("ml");
  });

  it("stays silent when the local file is missing or has no episodes", async () => {
    expect(
      await readLocalEpisodes(config, async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
    expect(await readLocalEpisodes(config, fileWith({ episodes: "not an array" }))).toEqual([]);
    expect(formatDegradedContext([])).toBe("");
  });

  it("labels the block as degraded so the model does not read it as full context", async () => {
    const block = await buildDegradedContext(
      config,
      fileWith({ episodes: [{ at: "2026-08-04T00:00:00Z", summary: "recent thing", theme_id: "ml" }] }),
    );
    expect(block).toContain("User Memory Context (degraded)");
    expect(block).toContain("unreachable");
    expect(block).toContain("recent thing");
  });

  it("returns nothing when the rail is switched off", async () => {
    expect(
      await buildDegradedContext(
        { ...config, enabled: false },
        fileWith({ episodes: [{ at: "2026-08-04T00:00:00Z", summary: "recent thing" }] }),
      ),
    ).toBe("");
  });
});
