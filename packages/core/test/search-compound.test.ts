import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-search-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("searchBundle natural-language queries with a compound identifier", () => {
  it("ranks the concept that contains the identifier above notes that only share common words", async () => {
    for (let i = 0; i < 20; i++) {
      await kb.writeConcept(
        `/noise-${i}.md`,
        { type: "Note", title: `Meeting ${i}` },
        "We discussed how the scheduler does its work and what it refuses to do when it is asked to run twice.",
        "seed"
      );
    }
    await kb.writeConcept(
      "/skill-linker.md",
      { type: "Fact", title: "Skill linker" },
      "tools/bridge-skills.sh links skills into the agent directory. It refuses builtin names and real directories.",
      "seed"
    );

    const hits = await kb.search("How does bridge-skills.sh work and what does it refuse to symlink?", { limit: 5 });

    expect(hits[0]?.path).toBe("/skill-linker.md");
  });

  it("preserves 2-character technical queries like s3 or db without triggering browse mode", async () => {
    await kb.writeConcept(
      "/unrelated.md",
      { type: "Note", title: "Frontend styles" },
      "Updated button margins and typography tokens.",
      "seed"
    );
    await kb.writeConcept(
      "/storage.md",
      { type: "Fact", title: "Bucket lifecycle" },
      "The s3 bucket lifecycle rule expires logs after 30 days.",
      "seed"
    );

    const hits = await kb.search("s3");

    expect(hits.map((h) => h.path)).toEqual(["/storage.md"]);
  });

  it("returns no hits for punctuation-only queries instead of falling back to browse mode", async () => {
    await kb.writeConcept(
      "/note.md",
      { type: "Note", title: "Sample" },
      "Some content here.",
      "seed"
    );

    expect(await kb.search("???")).toEqual([]);
    expect(await kb.search("---")).toEqual([]);
  });

  it("scores compound identifiers matched in description and tags", async () => {
    await kb.writeConcept(
      "/noise.md",
      { type: "Note", title: "General region note" },
      "Discusses east coast latency in general terms.",
      "seed"
    );
    await kb.writeConcept(
      "/tagged.md",
      {
        type: "Fact",
        title: "Failover target",
        description: "Primary cluster in us-east-1",
        tags: ["us-east-1", "infra"],
      },
      "Handles regional traffic.",
      "seed"
    );

    const hits = await kb.search("What runs in us-east-1?");

    expect(hits[0]?.path).toBe("/tagged.md");
  });

  it("does not leak short file extensions from compound identifiers into unrelated words", async () => {
    await kb.writeConcept(
      "/extension-noise.md",
      { type: "Note", title: "Status update" },
      "Its results show common patterns across items.",
      "seed"
    );
    await kb.writeConcept(
      "/target-file.md",
      { type: "Fact", title: "Search module" },
      "Implemented inside search.ts for bundle queries.",
      "seed"
    );

    const hits = await kb.search("search.ts");

    expect(hits.map((h) => h.path)).toEqual(["/target-file.md"]);
  });

  it("uses IDF weighting so rare technical terms outweigh ubiquitous corpus terms", async () => {
    for (let i = 0; i < 12; i++) {
      await kb.writeConcept(
        `/common-${i}.md`,
        { type: "Note", title: `Service config ${i}` },
        "Standard service configuration and deployment settings.",
        "seed"
      );
    }
    await kb.writeConcept(
      "/rare-term.md",
      { type: "Fact", title: " eviction policy" },
      "Uses turboquant cache compression for service memory.",
      "seed"
    );

    const hits = await kb.search("service turboquant", { limit: 5 });

    expect(hits[0]?.path).toBe("/rare-term.md");
  });

  it("propagates 1-hop OKF markdown links from top hits to surface linked spoke concepts", async () => {
    await kb.writeConcept(
      "/hub.md",
      { type: "Concept", title: "Prefill Juggling Router" },
      "Routes oversized prefill prompts to the fallback lane. See [KV Eviction Policy](/spoke-kv.md) for cache limits.",
      "seed"
    );
    await kb.writeConcept(
      "/spoke-kv.md",
      { type: "Fact", title: "KV Eviction Policy" },
      "Drops cold pages after 120 seconds of inactivity.",
      "seed"
    );

    const hits = await kb.search("Prefill Juggling Router", { limit: 5 });

    expect(hits[0]?.path).toBe("/hub.md");
    expect(hits.some((h) => h.path === "/spoke-kv.md")).toBe(true);
  });
});
