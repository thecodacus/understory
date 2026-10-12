import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import {
  clearHotMemory,
  hotLookup,
  recordHotDelete,
  recordHotQuery,
  recordHotWrite,
} from "../src/agent/hot-memory.js";
import { clearQueryCache, runQueryCached } from "../src/agent/query-cache.js";
import type { QueryResult } from "../src/agent/agent.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-hot-"));
  kb = new KnowledgeBase(root);
  clearHotMemory();
  clearQueryCache();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.HOT_MEMORY;
  delete process.env.HOT_MEMORY_TTL;
});

describe("hotLookup", () => {
  it("returns null without calling the model when the hot set is empty", async () => {
    const generate = vi.fn();
    expect(await hotLookup(kb, "anything?", {}, generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers from recently written concepts (read fresh) and falls through on UNKNOWN", async () => {
    await kb.writeConcept("/facts/deploy.md", { type: "Fact", title: "Deploy day" }, "We deploy on Fridays.", "add");
    recordHotWrite(kb, "/facts/deploy.md");

    const confident = vi.fn(async () => "We deploy on Fridays. (from /facts/deploy.md)");
    const answer = await hotLookup(kb, "when do we deploy?", {}, confident);
    expect(answer).toContain("Fridays");
    const prompt = confident.mock.calls[0][1] as string;
    expect(prompt).toContain("/facts/deploy.md");
    expect(prompt).toContain("We deploy on Fridays.");

    const unsure = vi.fn(async () => "UNKNOWN");
    expect(await hotLookup(kb, "what is the capital of France?", {}, unsure)).toBeNull();
  });

  it("purges hot Q&As on writes and drops deleted concepts", async () => {
    recordHotQuery(kb, "q1", "a1");
    recordHotWrite(kb, "/facts/x.md"); // any write invalidates prior answers
    const generate = vi.fn(async () => "should not matter");
    // /facts/x.md doesn't exist on disk → dropped at read; Q&As purged → empty set → null.
    expect(await hotLookup(kb, "q1", {}, generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();

    recordHotDelete(kb, "/facts/x.md");
    expect(await hotLookup(kb, "q1", {}, generate)).toBeNull();
  });

  it("expires entries after HOT_MEMORY_TTL and respects HOT_MEMORY=false", async () => {
    vi.useFakeTimers();
    try {
      process.env.HOT_MEMORY_TTL = "1m";
      await kb.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "alpha", "add");
      recordHotWrite(kb, "/facts/a.md");
      vi.advanceTimersByTime(61_000);
      const generate = vi.fn();
      expect(await hotLookup(kb, "a?", {}, generate)).toBeNull();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    process.env.HOT_MEMORY = "false";
    await kb.writeConcept("/facts/b.md", { type: "Fact", title: "B" }, "beta", "add");
    recordHotWrite(kb, "/facts/b.md");
    const generate = vi.fn();
    expect(await hotLookup(kb, "b?", {}, generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("runQueryCached layering", () => {
  it("hot answers short-circuit the deep agent and land in the exact cache", async () => {
    const deep = vi.fn(async (): Promise<QueryResult> => ({ answer: "deep", steps: 5, traceId: "t" }));
    const hot = vi.fn(async () => "hot answer");

    const first = await runQueryCached(kb, "q?", {}, deep, hot);
    expect(first.source).toBe("hot");
    expect(first.answer).toBe("hot answer");
    expect(deep).not.toHaveBeenCalled();

    // Identical repeat: exact cache now answers, hot not consulted again.
    const second = await runQueryCached(kb, "q?", {}, deep, hot);
    expect(second.source).toBe("cache");
    expect(hot).toHaveBeenCalledTimes(1);
  });

  it("deep answers feed the hot working set", async () => {
    const deep = vi.fn(async (): Promise<QueryResult> => ({ answer: "42", steps: 3, traceId: "t" }));
    await runQueryCached(kb, "meaning of life?", {}, deep, async () => null);

    // The recorded Q&A is now available to a real hot lookup.
    const generate = vi.fn(async () => "42 (from previous answer)");
    const answer = await hotLookup(kb, "what was the meaning of life again?", {}, generate);
    expect(answer).toContain("42");
    const prompt = generate.mock.calls[0][1] as string;
    expect(prompt).toContain("meaning of life?");
  });
});

describe("isolation between memories hosted by one process", () => {
  let otherRoot: string;
  let other: KnowledgeBase;

  beforeEach(async () => {
    otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-hot-other-"));
    other = new KnowledgeBase(otherRoot);
  });

  afterEach(async () => {
    await fs.rm(otherRoot, { recursive: true, force: true });
  });

  it("never offers one memory's hot set to another", async () => {
    await kb.writeConcept("/facts/secret.md", { type: "Fact", title: "Secret" }, "The code is 4417.", "add");
    recordHotWrite(kb, "/facts/secret.md");
    recordHotQuery(kb, "what is the code?", "4417");

    const generate = vi.fn(async () => "4417");
    // The other memory has nothing hot: no model call, no answer.
    expect(await hotLookup(other, "what is the code?", {}, generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    // The owning memory still answers.
    expect(await hotLookup(kb, "what is the code?", {}, generate)).toBe("4417");
  });

  it("never serves one memory's cached answer to another, even with identical (empty) bundles", async () => {
    const deepA = vi.fn(async (): Promise<QueryResult> => ({ answer: "from A", steps: 1, traceId: "a" }));
    const deepB = vi.fn(async (): Promise<QueryResult> => ({ answer: "from B", steps: 1, traceId: "b" }));
    const noHot = async () => null;

    // Both bundles are empty, so their content fingerprints are identical.
    expect((await runQueryCached(kb, "who am I?", {}, deepA, noHot)).answer).toBe("from A");
    const second = await runQueryCached(other, "who am I?", {}, deepB, noHot);
    expect(second.source).toBe("deep");
    expect(second.answer).toBe("from B");
    expect(deepB).toHaveBeenCalledTimes(1);
  });
});
