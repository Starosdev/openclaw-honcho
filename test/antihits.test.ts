import { describe, expect, it } from "vitest";
import {
  collectAntiHits,
  DEFAULT_ANTI_HITS,
  formatAntiHits,
  selectAntiHits,
  type ConclusionLike,
} from "../antihits.js";

function conclusion(id: string, content: string, createdAt: string): ConclusionLike {
  return { id, content, createdAt };
}

const NEW = conclusion("c-new", "prefers dark roast", "2026-08-01T00:00:00Z");
const OLD = conclusion("c-old", "prefers light roast", "2026-02-01T00:00:00Z");

describe("anti-hits selection", () => {
  it("returns an older near neighbour as superseded by the hit", () => {
    const selected = selectAntiHits([NEW], new Map([[NEW.id, [OLD]]]), DEFAULT_ANTI_HITS);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.conclusion.id).toBe("c-old");
    expect(selected[0]?.supersededBy.id).toBe("c-new");
  });

  it("never returns a neighbour newer than the hit", () => {
    const newer = conclusion("c-newer", "prefers decaf", "2026-08-09T00:00:00Z");
    expect(selectAntiHits([NEW], new Map([[NEW.id, [newer]]]), DEFAULT_ANTI_HITS)).toEqual([]);
  });

  it("drops neighbours that are already results, and duplicates of a result", () => {
    const restated = conclusion("c-dupe", "  Prefers   Dark Roast ", "2026-01-01T00:00:00Z");
    const selected = selectAntiHits([NEW, OLD], new Map([[NEW.id, [OLD, restated]]]), DEFAULT_ANTI_HITS);
    // OLD is itself a result, and c-dupe only restates NEW in different casing.
    expect(selected).toEqual([]);
  });

  it("reports the widest age gap first and honours the cap", () => {
    const older = conclusion("c-older", "prefers tea", "2026-01-01T00:00:00Z");
    const oldest = conclusion("c-oldest", "drinks no coffee", "2025-01-01T00:00:00Z");
    const selected = selectAntiHits(
      [NEW],
      new Map([[NEW.id, [older, OLD, oldest]]]),
      { ...DEFAULT_ANTI_HITS, maxAntiHits: 2 },
    );
    expect(selected.map((antiHit) => antiHit.conclusion.id)).toEqual(["c-oldest", "c-older"]);
  });

  it("claims each neighbour once across expanded hits", () => {
    const second = conclusion("c-second", "orders espresso", "2026-07-01T00:00:00Z");
    const selected = selectAntiHits(
      [NEW, second],
      new Map([
        [NEW.id, [OLD]],
        [second.id, [OLD]],
      ]),
      DEFAULT_ANTI_HITS,
    );
    expect(selected).toHaveLength(1);
  });
});

describe("anti-hits collection", () => {
  it("expands only the configured number of hits and tightens the neighbour distance", async () => {
    const calls: Array<{ query: string; topK?: number; distance?: number }> = [];
    const scope = {
      query: async (query: string, topK?: number, distance?: number) => {
        calls.push({ query, topK, distance });
        if (query === "coffee") {
          return [NEW, conclusion("c-2", "grinds beans fresh", "2026-07-01T00:00:00Z")];
        }
        return [OLD];
      },
    };

    const antiHits = await collectAntiHits(scope, "coffee", {
      topK: 10,
      maxDistance: 0.5,
      config: { ...DEFAULT_ANTI_HITS, expandTop: 1 },
    });

    expect(antiHits.map((antiHit) => antiHit.conclusion.id)).toEqual(["c-old"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ query: "coffee", topK: 10, distance: 0.5 });
    expect(calls[1]?.distance).toBeCloseTo(0.3);
  });

  it("searches nothing when disabled or when the primary search is empty", async () => {
    let searches = 0;
    const scope = {
      query: async () => {
        searches += 1;
        return [];
      },
    };

    expect(
      await collectAntiHits(scope, "coffee", {
        topK: 10,
        maxDistance: 0.5,
        config: { ...DEFAULT_ANTI_HITS, enabled: false },
      }),
    ).toEqual([]);
    expect(searches).toBe(0);

    expect(
      await collectAntiHits(scope, "coffee", {
        topK: 10,
        maxDistance: 0.5,
        config: DEFAULT_ANTI_HITS,
      }),
    ).toEqual([]);
    expect(searches).toBe(1);
  });
});

describe("anti-hits rendering", () => {
  it("says nothing when there is nothing to say", () => {
    expect(formatAntiHits([])).toBe("");
  });

  it("dates each line and refuses to claim contradiction", () => {
    const block = formatAntiHits([
      { conclusion: OLD, supersededBy: NEW, ageGapMs: 1 },
    ]);
    expect(block).toContain("[2026-02-01] prefers light roast");
    expect(block).toContain("2026-08-01");
    expect(block).toContain("not as current facts");
    expect(block).toContain("Nothing here is a proven contradiction.");
  });
});
