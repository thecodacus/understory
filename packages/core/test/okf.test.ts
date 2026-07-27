import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Bundle,
  BundleError,
  KnowledgeBase,
  parseDoc,
  replaceSection,
  validateBundle,
  regenerateIndex,
  readLog,
  searchBundle,
  lintBundle,
} from "../src/okf/index.js";
import { buildWriteTools } from "../src/agent/tools.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("frontmatter round-trip", () => {
  it("writes and reads a concept preserving fields, stamping timestamp", async () => {
    const written = await kb.writeConcept(
      "/tables/customers.md",
      { type: "BigQuery Table", title: "Customers", description: "Core customer table", tags: ["crm"], custom_key: 42 },
      "# Schema\n\nid, name, email",
      "Added customers table concept."
    );
    expect(written.frontmatter.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await kb.readConcept("/tables/customers.md");
    expect(read.frontmatter.type).toBe("BigQuery Table");
    expect(read.frontmatter.custom_key).toBe(42);
    expect(read.body).toContain("# Schema");
  });

  it("rejects concepts without a type", async () => {
    await expect(
      kb.writeConcept("/x.md", { type: "" } as never, "body", "log")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("rejects reserved filenames as concepts", async () => {
    await expect(
      kb.writeConcept("/index.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
    await expect(
      kb.writeConcept("/sub/log.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
  });

  it("is permissive reading unknown keys and types", () => {
    const { frontmatter } = parseDoc(`---\ntype: Alien Format\nweird: [1, 2]\n---\nbody`);
    expect(frontmatter.type).toBe("Alien Format");
    expect(frontmatter.weird).toEqual([1, 2]);
  });
});

describe("sandbox", () => {
  it("rejects .. escapes", () => {
    const bundle = new Bundle(root);
    expect(() => bundle.resolve("/../../etc/passwd")).toThrow(BundleError);
    expect(() => bundle.resolve("../outside.md")).toThrow(BundleError);
  });

  it("allows normal nested paths", () => {
    const bundle = new Bundle(root);
    expect(bundle.resolve("/a/b/c.md")).toBe(path.join(root, "a/b/c.md"));
  });
});

describe("index regeneration (spec §6)", () => {
  it("generates bullet lists with titles and descriptions, root gets okf_version", async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "Customer records" },
      "body",
      "add"
    );
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).toContain('okf_version: "0.1"');
    expect(rootIndex).toContain("## Memory Segments");
    // Segment lines summarize contents: count, types, titles — not just "subdirectory".
    expect(rootIndex).toContain("* [tables](tables/) - 1 concept (Table): Customers");

    const dirIndex = await fs.readFile(path.join(root, "tables/index.md"), "utf-8");
    expect(dirIndex).toContain("* [Customers](customers.md) - Customer records");
    // index.md must not have frontmatter outside root
    expect(dirIndex.startsWith("---")).toBe(false);
  });

  it("regenerates the whole ancestor chain after nested writes", async () => {
    await kb.writeConcept("/a/b/deep.md", { type: "T", title: "Deep" }, "x", "add deep");
    for (const p of ["index.md", "a/index.md", "a/b/index.md"]) {
      await expect(fs.access(path.join(root, p))).resolves.toBeUndefined();
    }
  });
});

describe("log (spec §7)", () => {
  it("appends newest-first with action bullets under ISO date headings", async () => {
    await kb.writeConcept("/one.md", { type: "T", title: "One" }, "x", "Created one.");
    await kb.writeConcept("/one.md", { type: "T", title: "One" }, "y", "Updated one.");
    await kb.deleteConcept("/one.md", "Removed one.");

    const log = await fs.readFile(path.join(root, "log.md"), "utf-8");
    expect(log).toMatch(/^# Directory Update Log/);
    expect(log).toMatch(/## \d{4}-\d{2}-\d{2}/);

    const entries = await readLog(kb.bundle);
    expect(entries.map((e) => e.action)).toEqual(["Deletion", "Update", "Creation"]);
    expect(entries[0].summary).toBe("Removed one.");
  });
});

describe("patch", () => {
  it("merges frontmatter and replaces a named section only", async () => {
    await kb.writeConcept(
      "/doc.md",
      { type: "T", title: "Doc", tags: ["a"] },
      "intro text\n\n# Schema\n\nold schema\n\n# Examples\n\nkeep me",
      "add"
    );
    const patched = await kb.patchConcept(
      "/doc.md",
      { frontmatter: { tags: ["a", "b"] }, replaceSection: { heading: "Schema", content: "new schema" } },
      "Updated schema section."
    );
    expect(patched.frontmatter.tags).toEqual(["a", "b"]);
    expect(patched.body).toContain("new schema");
    expect(patched.body).not.toContain("old schema");
    expect(patched.body).toContain("keep me");
    expect(patched.body).toContain("intro text");
  });

  it("appends the section when the heading is absent", () => {
    const out = replaceSection("just a body", "Citations", "[1] [X](https://x.com)");
    expect(out).toContain("# Citations");
    expect(out).toContain("[1] [X](https://x.com)");
    expect(out).toContain("just a body");
  });
});

describe("search", () => {
  beforeEach(async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "CRM customer records", tags: ["crm"] },
      "Contains emails and billing country.",
      "add"
    );
    await kb.writeConcept(
      "/apis/billing.md",
      { type: "API Endpoint", title: "Billing API", tags: ["billing"] },
      "Charges customers monthly.",
      "add"
    );
  });

  it("ranks title matches above body matches", async () => {
    const hits = await searchBundle(kb.bundle, "customers");
    expect(hits[0].path).toBe("/tables/customers.md");
    expect(hits.length).toBe(2); // body match on billing too
  });

  it("filters by type and tags", async () => {
    const byType = await searchBundle(kb.bundle, "customers", { type: "API Endpoint" });
    expect(byType.map((h) => h.path)).toEqual(["/apis/billing.md"]);
    const byTag = await searchBundle(kb.bundle, "", { tags: ["crm"] });
    expect(byTag.map((h) => h.path)).toEqual(["/tables/customers.md"]);
  });
});

describe("conformance (spec §9)", () => {
  it("valid bundle passes; missing type is an error; broken link is only a warning", async () => {
    await kb.writeConcept(
      "/good.md",
      { type: "T", title: "Good", description: "fine" },
      "See [missing](/nope.md).",
      "add"
    );
    // Write a malformed concept behind the KB's back.
    await fs.writeFile(path.join(root, "bad.md"), `---\ntitle: No Type\n---\nbody\n`);

    const report = await validateBundle(kb.bundle);
    expect(report.conformant).toBe(false);
    expect(report.issues.some((i) => i.severity === "error" && i.path === "/bad.md")).toBe(true);
    const linkIssue = report.issues.find((i) => i.message.includes("/nope.md"));
    expect(linkIssue?.severity).toBe("warning");

    await fs.rm(path.join(root, "bad.md"));
    const clean = await validateBundle(kb.bundle);
    expect(clean.conformant).toBe(true);
  });
});

describe("lint (graph health)", () => {
  it("flags orphans (no inbound links) and treats index catalogs as non-sources", async () => {
    // hub is linked-to; spoke links out but nothing links back to it; lonely is isolated.
    await kb.writeConcept("/hub.md", { type: "T", title: "Hub" }, "The central concept.", "add");
    await kb.writeConcept("/spoke.md", { type: "T", title: "Spoke" }, "See [Hub](/hub.md).", "add");
    await kb.writeConcept("/lonely.md", { type: "T", title: "Lonely" }, "Nothing here links out.", "add");

    const report = await lintBundle(kb.bundle);
    const orphanPaths = report.orphans.map((o) => o.path).sort();
    // hub has an inbound link → not orphan. spoke + lonely have none → orphans.
    // The generated index.md files must NOT count as inbound links.
    expect(orphanPaths).toEqual(["/lonely.md", "/spoke.md"]);
    expect(report.linkCount).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it("flags broken links and reports healthy when fully wired", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "Link to [B](/b.md).", "add");
    let report = await lintBundle(kb.bundle);
    expect(report.brokenLinks).toEqual([{ path: "/a.md", target: "/b.md" }]);

    // Add B and a back-link so nothing is orphaned or broken.
    await kb.writeConcept("/b.md", { type: "T", title: "B" }, "Back to [A](/a.md).", "add");
    report = await lintBundle(kb.bundle);
    expect(report.brokenLinks).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.healthy).toBe(true);
  });
});

describe("graph export", () => {
  it("returns nodes with metadata/degree and deduped edges", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A", description: "alpha" }, "See [B](/b.md) and again [B](/b.md).", "add");
    await kb.writeConcept("/b.md", { type: "U", title: "B" }, "Back to [A](/a.md).", "add");
    await kb.writeConcept("/c.md", { type: "T", title: "C" }, "island", "add");

    const graph = await kb.graph();
    expect(graph.nodes.length).toBe(3);
    const a = graph.nodes.find((n) => n.path === "/a.md")!;
    expect(a.title).toBe("A");
    expect(a.description).toBe("alpha");
    expect(a.links).toBe(2); // one out (deduped), one in
    expect(graph.nodes.find((n) => n.path === "/c.md")!.links).toBe(0);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "/a.md", target: "/b.md" },
        { source: "/b.md", target: "/a.md" },
      ])
    );
    expect(graph.edges.length).toBe(2); // duplicate A→B link counted once
  });
});

describe("mutation serialization", () => {
  it("concurrent writes all land and log all entries", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        kb.writeConcept(`/c${i}.md`, { type: "T", title: `C${i}` }, "x", `Added C${i}.`)
      )
    );
    const entries = await readLog(kb.bundle);
    expect(entries.length).toBe(8);
    const tree = await kb.listTree();
    const concepts = tree.children!.filter((c) => c.kind === "concept");
    expect(concepts.length).toBe(8);
  });
});

describe("empty directory pruning (#10)", () => {
  it("prunes a directory left holding only its index.md after the last concept is deleted", async () => {
    await kb.writeConcept("/family/children/kid.md", { type: "Person", title: "Kid" }, "x", "add");
    await kb.writeConcept("/family/parent.md", { type: "Person", title: "Parent" }, "x", "add");
    await kb.deleteConcept("/family/children/kid.md", "moved elsewhere");

    // /family/children held only index.md → gone; /family still has parent.md → kept.
    await expect(fs.access(path.join(root, "family/children"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "family/parent.md"))).resolves.toBeUndefined();
    // Parent index no longer lists the pruned subdirectory.
    const familyIndex = await fs.readFile(path.join(root, "family/index.md"), "utf-8");
    expect(familyIndex).not.toContain("children");
  });

  it("prunes emptied ancestor chains but never the root", async () => {
    await kb.writeConcept("/a/b/c/deep.md", { type: "T", title: "Deep" }, "x", "add");
    await kb.writeConcept("/other/keep.md", { type: "T", title: "Keep" }, "x", "add");
    await kb.deleteConcept("/a/b/c/deep.md", "gone");

    for (const dir of ["a/b/c", "a/b", "a"]) {
      await expect(fs.access(path.join(root, dir))).rejects.toThrow();
    }
    await expect(fs.access(root)).resolves.toBeUndefined();
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).not.toContain("[a](a/)");
    expect(rootIndex).toContain("other");
  });

  it("heals pre-existing husks on the next unrelated mutation and spares dot-dirs", async () => {
    // Simulate an old husk + a .traces dir behind the KB's back.
    await fs.mkdir(path.join(root, "husk"), { recursive: true });
    await fs.writeFile(path.join(root, "husk/index.md"), "# Husk\n");
    await fs.mkdir(path.join(root, ".traces"), { recursive: true });
    await fs.writeFile(path.join(root, ".traces/t.json"), "{}");

    await kb.writeConcept("/fresh.md", { type: "T", title: "Fresh" }, "x", "add");

    await expect(fs.access(path.join(root, "husk"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".traces/t.json"))).resolves.toBeUndefined();
  });
});

describe("deferred inbox", () => {
  it("captures raw knowledge immediately and archives only that captured item", async () => {
    const captured = await kb.captureInboxItem("A durable item waiting for curation.");
    expect(captured.path).toMatch(/^\/inbox\/[a-z0-9-]+\.json$/);
    expect(await kb.readInboxItem(captured.id)).toBe("A durable item waiting for curation.");
    expect((await kb.listInboxItems()).map((item) => item.id)).toEqual([captured.id]);

    const archived = await kb.archiveInboxItem(captured.id);
    expect(archived.path).toMatch(/^\/archive\/inbox\/[a-z0-9-]+\.json$/);
    expect(await kb.listInboxItems()).toEqual([]);
    await expect(fs.access(kb.bundle.resolve(archived.path))).resolves.toBeUndefined();
  });

  it("atomically lets only one caller claim a captured item", async () => {
    await kb.captureInboxItem("Claim me once.");
    const claims = await Promise.all([kb.claimNextInboxItem(), kb.claimNextInboxItem()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(await kb.readClaimedInboxItem(claim.id)).toBe("Claim me once.");
    await kb.releaseInboxClaim(claim.id);
  });

  it("enforces the constrained curation write policy in code", async () => {
    const tools = buildWriteTools(kb, new Set(), undefined, {
      allowedWritePaths: ["/curated-inbox/only-this.md"],
      createOnlyPaths: ["/curated-inbox/only-this.md"],
      allowPatch: false,
      allowDelete: false,
    }) as any;

    await expect(
      tools.write_concept.execute({
        path: "/outside.md",
        frontmatter: { type: "Test" },
        body: "must not write",
        log_summary: "Attempted an outside write.",
      })
    ).rejects.toThrow("Write policy forbids write_concept");
    await expect(
      tools.patch_concept.execute({ path: "/outside.md", log_summary: "Attempted patch." })
    ).rejects.toThrow("Write policy forbids patch_concept");
    await expect(
      tools.delete_concept.execute({ path: "/outside.md", log_summary: "Attempted delete." })
    ).rejects.toThrow("Write policy forbids delete_concept");

    const input = {
      path: "/curated-inbox/only-this.md",
      frontmatter: { type: "Test" },
      body: "Created exactly once.",
      log_summary: "Created a constrained test concept.",
    };
    await expect(tools.write_concept.execute(input)).resolves.toEqual({ written: input.path });
    await expect(tools.write_concept.execute(input)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
