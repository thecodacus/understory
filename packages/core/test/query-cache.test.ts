import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { bundleFingerprint, clearQueryCache, runQueryCached } from "../src/agent/query-cache.js";
import { clearHotMemory } from "../src/agent/hot-memory.js";
import { parseDuration } from "../src/util/duration.js";
import type { QueryResult } from "../src/agent/agent.js";

let root: string;
let kb: KnowledgeBase;

function fakeRunner(answer: string) {
  return vi.fn(
    async (): Promise<QueryResult> => ({ answer, steps: 1, traceId: "t" })
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-cache-"));
  kb = new KnowledgeBase(root);
  clearQueryCache();
  clearHotMemory();
  process.env.HOT_MEMORY = "false";
  await kb.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "alpha", "add");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.QUERY_CACHE;
  delete process.env.QUERY_CACHE_TTL;
  delete process.env.HOT_MEMORY;
});

describe("runQueryCached", () => {
  it("serves repeats from cache without re-running the agent", async () => {
    const runner = fakeRunner("answer-1");
    const first = await runQueryCached(kb, "what is A?", {}, runner);
    const second = await runQueryCached(kb, "  What is  A? ", {}, runner); // normalized match
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.answer).toBe("answer-1");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("invalidates when the bundle changes", async () => {
    const runner = fakeRunner("answer");
    await runQueryCached(kb, "what is A?", {}, runner);
    await kb.writeConcept("/facts/b.md", { type: "Fact", title: "B" }, "beta — longer content", "add");
    const after = await runQueryCached(kb, "what is A?", {}, runner);
    expect(after.cached).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("misses on a different question and respects QUERY_CACHE=false", async () => {
    const runner = fakeRunner("answer");
    await runQueryCached(kb, "q1", {}, runner);
    await runQueryCached(kb, "q2", {}, runner);
    expect(runner).toHaveBeenCalledTimes(2);

    process.env.QUERY_CACHE = "false";
    await runQueryCached(kb, "q1", {}, runner);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers();
    try {
      process.env.QUERY_CACHE_TTL = "1m";
      const runner = fakeRunner("answer");
      await runQueryCached(kb, "q", {}, runner);
      vi.advanceTimersByTime(61_000);
      const after = await runQueryCached(kb, "q", {}, runner);
      expect(after.cached).toBe(false);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bundleFingerprint", () => {
  it("is stable for an unchanged bundle and moves on writes", async () => {
    const f1 = await bundleFingerprint(kb);
    const f2 = await bundleFingerprint(kb);
    expect(f1).toBe(f2);
    await kb.writeConcept("/facts/c.md", { type: "Fact", title: "C" }, "gamma", "add");
    expect(await bundleFingerprint(kb)).not.toBe(f1);
  });
});

describe("parseDuration", () => {
  it("parses common forms and rejects junk", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("6h")).toBe(21_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration("soon")).toBeNull();
  });
});
