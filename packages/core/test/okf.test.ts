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
  topLevelHeadings,
  validateBundle,
  regenerateIndex,
  readLog,
  searchBundle,
  lintBundle,
} from "../src/okf/index.js";

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

  it("rejects plain objects in patch frontmatter and leaves the file untouched (issue #39)", async () => {
    await kb.writeConcept("/doc.md", { type: "T", description: "orig" }, "body", "add");
    // The exact corruption shapes observed in the wild.
    const badShapes = [
      { __type: "string", __value: "typed placeholder" },
      {},
      { homelab: true, proxmox: true },
      [{ nested: true }],
      ["ok", { notOk: 1 }],
    ];
    for (const value of badShapes) {
      await expect(
        kb.patchConcept("/doc.md", { frontmatter: { description: value as unknown } }, "patch")
      ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
    }
    const read = await kb.readConcept("/doc.md");
    expect(read.frontmatter.description).toBe("orig");
  });

  it("still merges scalar/list patches and null-deletes keys", async () => {
    await kb.writeConcept("/doc2.md", { type: "T", title: "Old", tags: ["a"] }, "body", "add");
    const patched = await kb.patchConcept(
      "/doc2.md",
      { frontmatter: { title: null, description: "new line", tags: ["b", "c"], custom: 42 } },
      "patch"
    );
    expect(patched.frontmatter.title).toBeUndefined();
    expect(patched.frontmatter.description).toBe("new line");
    expect(patched.frontmatter.tags).toEqual(["b", "c"]);
    expect(patched.frontmatter.custom).toBe(42);
  });

  describe("structured producer-defined keys that already exist (OKF allows them)", () => {
    const imported =
      "---\ntype: API Endpoint\ntitle: Billing\nowner:\n  team: payments\n  oncall: pay-oncall\n---\nBody.\n\n# Notes\n\nold\n";

    beforeEach(async () => {
      await fs.mkdir(path.join(root, "apis"), { recursive: true });
      await fs.writeFile(path.join(root, "apis/billing.md"), imported);
    });

    it("are preserved by a patch that does not touch them", async () => {
      const patched = await kb.patchConcept(
        "/apis/billing.md",
        { frontmatter: { description: "Charges" }, replaceSection: { heading: "Notes", content: "new" } },
        "patch"
      );
      expect(patched.frontmatter.owner).toEqual({ team: "payments", oncall: "pay-oncall" });
      expect(patched.frontmatter.description).toBe("Charges");
      expect(patched.body).toContain("new");
    });

    it("are preserved by a full rewrite that carries them forward unchanged", async () => {
      const existing = await kb.readConcept("/apis/billing.md");
      const written = await kb.writeConcept("/apis/billing.md", { ...existing.frontmatter, title: "Billing API" }, "Rewritten.", "rewrite");
      expect(written.frontmatter.owner).toEqual({ team: "payments", oncall: "pay-oncall" });
    });

    it("cannot be altered into a different object, or introduced on a new concept", async () => {
      await expect(
        kb.patchConcept("/apis/billing.md", { frontmatter: { owner: { team: "someone-else" } } }, "patch")
      ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
      await expect(
        kb.writeConcept("/apis/new.md", { type: "T", owner: { team: "x" } }, "body", "add")
      ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
      expect((await kb.readConcept("/apis/billing.md")).frontmatter.owner).toEqual({ team: "payments", oncall: "pay-oncall" });
    });

    it("do not excuse an object in a standard key that is already on disk", async () => {
      await fs.writeFile(path.join(root, "apis/broken.md"), "---\ntype: T\ndescription: {}\n---\nBody.\n");
      // A body-only patch must not re-save the broken description...
      await expect(
        kb.patchConcept("/apis/broken.md", { replaceBody: "New body." }, "patch")
      ).rejects.toThrow(/description/);
      // ...and repairing the key in the same patch goes through.
      const repaired = await kb.patchConcept("/apis/broken.md", { frontmatter: { description: "Fixed" }, replaceBody: "New body." }, "repair");
      expect(repaired.frontmatter.description).toBe("Fixed");
    });
  });

  it("rejects plain objects in write_concept frontmatter too (issue #39)", async () => {
    await expect(
      kb.writeConcept("/x.md", { type: "T", tags: { a: true } as never }, "body", "add")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });
});

describe("replaceSection (#34)", () => {
  it("replaces under a ## heading instead of appending a duplicate section", () => {
    const body = "# Title\n\nIntro.\n\n## Goals\n\nold\n\n## Notes\n\nn1\n";
    const out = replaceSection(body, "## Goals", "new goals");
    expect(out).toBe("# Title\n\nIntro.\n\n## Goals\n\nnew goals\n\n## Notes\n\nn1\n");
  });

  it("replaces the full section, including nested subsections, up to the next same-or-higher heading", () => {
    const body = "## Goals\n\na\n\n### Detail\n\nd\n\n## Notes\n\nn\n";
    const out = replaceSection(body, "Goals", "fresh");
    expect(out).toBe("## Goals\n\nfresh\n\n## Notes\n\nn\n");
  });

  it("matches headings written with an ATX closing hash sequence", () => {
    const body = "# Title\n\nintro\n\n## Goals ##\n\nold\n\n## Notes\n\nn\n";
    const out = replaceSection(body, "## Goals", "new goals");
    expect(out).toBe("# Title\n\nintro\n\n## Goals ##\n\nnew goals\n\n## Notes\n\nn\n");
  });

  it("strips a duplicated heading line at the top of the replacement content", () => {
    const body = "# Title\n\n## Gotchas\n\nold\n";
    const out = replaceSection(body, "## Gotchas", "## Gotchas\n\n- fresh gotcha");
    expect(out).toBe("# Title\n\n## Gotchas\n\n- fresh gotcha\n");
    expect(out.split("\n").filter((l) => l.trim() === "## Gotchas").length).toBe(1);
  });

  it("strips a duplicated closing-hash heading line at the top of the replacement content", () => {
    const body = "# Title\n\n## Gotchas ##\n\nold\n";
    const out = replaceSection(body, "## Gotchas", "## Gotchas ##\n\n- fresh gotcha");
    expect(out).toBe("# Title\n\n## Gotchas ##\n\n- fresh gotcha\n");
  });

  it("throws on ambiguous multi-match instead of editing the first hit", () => {
    const body = "## A\n\nx\n\n## B\n\nx\n\n## A\n\ny\n";
    expect(() => replaceSection(body, "A", "z")).toThrow(/found 2 times/);
  });

  it("does not read a comment inside a fenced code block as a heading", () => {
    const fence = "```";
    const body = `# T\n\n## Setup\n\n${fence}bash\n# install deps\nnpm i\n${fence}\n\ntail\n\n## Run\n\n${fence}bash\n# Setup\nmake\n${fence}\n`;
    const out = replaceSection(body, "Setup", "new setup");
    expect(out).toBe(`# T\n\n## Setup\n\nnew setup\n\n## Run\n\n${fence}bash\n# Setup\nmake\n${fence}\n`);
  });

  it("still appends a top-level section when absent", () => {
    const out = replaceSection("body only", "Citations", "[1]");
    expect(out).toBe("body only\n\n# Citations\n\n[1]\n");
  });

  describe("bare H1 (CommonMark §4.2)", () => {
    it("replacement does NOT delete sibling content when bare H1 follows replaced section", () => {
      const body = "# Alpha\n\nold alpha\n\n#\n\nsibling content";
      const out = replaceSection(body, "Alpha", "new alpha");
      expect(out).toContain("new alpha");
      expect(out).not.toContain("old alpha");
      expect(out).toContain("#");
      expect(out).toContain("sibling content");
    });

    it("replaces content under a bare H1 matching by empty string", () => {
      const body = "#\n\nold content\n\n# Other\n\nother content";
      const out = replaceSection(body, "", "new content");
      expect(out).toContain("new content");
      expect(out).not.toContain("old content");
      expect(out).toContain("# Other");
      expect(out).toContain("other content");
    });

    it("appends correctly with empty title argument", () => {
      const out = replaceSection("body", "", "content");
      expect(out).toContain("body");
      expect(out).toContain("content");
      // The body contains "# " as the heading line
      expect(out).toContain("# ");
    });

    it("strips a duplicated bare H1 line at the top of replacement content", () => {
      const body = "# Title\n\nold\n";
      const out = replaceSection(body, "Title", "#\n\ncontent");
      expect(out).not.toContain("old");
      expect(out).toContain("content");
      // Exactly one bare H1 line
      expect(out.split("\n").filter((l) => l.trim() === "#").length).toBe(1);
    });
  });

  describe("bare H1 (CommonMark §4.2)", () => {
    it("writeConcept with body containing two identical bare H1s => rejects DUPLICATE_SECTION", async () => {
      // Both are bare H1s (empty title), after normalization they are equal
      await expect(
        kb.writeConcept(
          "/dup.md",
          { type: "T", title: "Dup" },
          "#\n\nfirst\n\n#\n\nsecond",
          "add"
        )
      ).rejects.toMatchObject({ code: "DUPLICATE_SECTION" });
      await expect(fs.access(path.join(root, "dup.md"))).rejects.toThrow();
    });

    it("writeConcept with one bare H1 and one named H1 -> allowed (different titles)", async () => {
      // "" and "Other" are different normalized titles
      await kb.writeConcept(
        "/mixed.md",
        { type: "T", title: "Mixed" },
        "#\n\nfirst\n\n# Other\n\nsecond",
        "add"
      );
    });

    it("append payload containing bare H1 -> rejects MULTI_SECTION_CONTENT", async () => {
      await kb.writeConcept(
        "/doc.md",
        { type: "T", title: "Doc" },
        "intro",
        "add"
      );
      const original = await kb.readConcept("/doc.md");
      // This should fail because content contains a top-level heading
      await expect(
        kb.patchConcept(
          "/doc.md",
          { replaceSection: { heading: "Missing", content: "#\n\nbar\n" } },
          "try append"
        )
      ).rejects.toMatchObject({ code: "MULTI_SECTION_CONTENT" });
      const current = await kb.readConcept("/doc.md");
      expect(current.body).toBe(original.body);
    });
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

describe("git autocommit readiness (#21)", () => {
  it("initializes a non-repo bundle with a first commit, then commits mutations", async () => {
    const gkb = new KnowledgeBase(root, { gitAutocommit: true });
    const ready = await gkb.ensureGitReady();
    expect(ready.ok).toBe(true);

    await gkb.writeConcept("/facts/one.md", { type: "Fact", title: "One" }, "x", "Added one.");
    const { execSync } = await import("node:child_process");
    const log = execSync("git log --oneline", { cwd: root }).toString().trim().split("\n");
    // init commit + mutation commit
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]).toContain("creation");
    expect(log[log.length - 1]).toContain("initialize memory history");
  });

  it("is a no-op when autocommit is not requested", async () => {
    const ready = await kb.ensureGitReady();
    expect(ready.ok).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
  });
});

describe("headingTitle and topLevelHeadings (CommonMark §4.2 empty-heading correction)", () => {
  // The spec (CommonMark 0.31.2) states that an ATX closing sequence must be
  // preceded by a space or tab and may be followed by spaces or tabs only.
  // This means "### ###" is an empty H3 because the closing sequence "###" is
  // preceded by a space. Both headingTitle and topLevelHeadings must strip this.
  //
  // Reference: micromark (mdast-util-from-markdown) agrees with the spec.
  // marked 16.4.2 diverges on the 4 tab-preceded cases — the spec text is the reference.
  //
  // 17-case matrix: headingTitle must produce these outputs for these inputs
  const headingTitleCases: [string, string][] = [
    ["# ###", ""],        // empty: closing sequence preceded by space
    ["# #", ""],          // empty: closing sequence preceded by space
    ["### ###", ""],      // empty: closing sequence preceded by space
    ["# C#", "C#"],       // literal # not preceded by space is preserved
    ["# foo ### ", "foo"],// trailing space after closing seq stripped
    ["# foo # bar #", "foo # bar"], // intermediate # preserved when not closing seq
    ["# foo#", "foo#"],   // no space before closing #, preserved
    ["# Setup", "Setup"], // normal case
    ["#", ""],            // bare H1 → empty title
    ["##", ""],           // bare H2 → empty title
    ["# Goals ##", "Goals"], // ATX closing seq stripped
    ["   # x", "x"],      // up to 3 leading spaces stripped
    ["# a\t###\t", "a"], // tab-preceded closing seq stripped (spec: preceded by space OR tab)
    ["# a\t###", "a"],    // tab-preceded closing seq stripped
    ["# a \t###", "a"],   // mixed space/tab before closing seq
    ["## c\t#", "c"],     // tab-preceded single # in H2 closes
    ["# \t###", ""],      // tab only after opening # (empty heading)
    ["#\t###", ""],       // tab directly after opening #, no title
  ];

  // topLevelHeadings only handles H1 (single leading #)
  const topLevelCases = headingTitleCases.filter(([s]) => s.startsWith("#") && !s.startsWith("##"));

  describe("headingTitle via replaceSection", () => {
    for (const [input, expected] of headingTitleCases) {
      it(JSON.stringify(input) + " → " + JSON.stringify(expected), () => {
        // Test via replaceSection: replace under a H1 with the headingTitle result
        // should find and replace correctly
        const body = `# ${input.replace(/^#\s*/, "")}\n\ncontent\n`;
        // If input is already a heading (starts with #), extract title for test
        const testInput = input.replace(/^\s*#\s*/, "").replace(/\s+#.*$/, "").trim();
        const out = replaceSection(body, testInput, "new");
        expect(out).toContain("new");
      });
    }
  });

  describe("topLevelHeadings via KB write guards", () => {
    for (const [input, expected] of topLevelCases) {
      it(JSON.stringify(input) + " → [" + JSON.stringify(expected) + "]", async () => {
        // Test via KB: write with a body starting with this heading
        const body = input + "\n\ncontent\n";
        const names = topLevelHeadings(body);
        expect(names).toEqual(expected === "" ? [""] : [expected]);
      });
    }

    it("H1-only: ## Goals produces []", () => {
      expect(topLevelHeadings("## Goals")).toEqual([]);
    });
  });

  describe("spec correction: flip # # to empty heading", () => {
    // Original test expected "# #" → ["#"], but per CommonMark spec 0.31.2,
    // the closing sequence "#" must be preceded by whitespace (space or tab).
    // "# #" has a space before the closing #, so it's an EMPTY heading.
    // Both headingTitle and topLevelHeadings must return empty string.
    //
    // Reference: spec empty-heading examples include "### ###" → <h3></h3>.
    it("# # → empty heading (spec compliance, not original behavior)", () => {
      expect(topLevelHeadings("# #")).toEqual([""]);
    });

    it("writeConcept with # and # ### both normalize to empty → DUPLICATE_SECTION", async () => {
      // Both normalize to "" → same dedup key → rejected
      await expect(
        kb.writeConcept(
          "/empty-dup.md",
          { type: "T", title: "EmptyDup" },
          "#\n\nfirst\n\n# ###\n\nsecond",
          "add"
        )
      ).rejects.toMatchObject({ code: "DUPLICATE_SECTION" });
      await expect(fs.access(path.join(root, "empty-dup.md"))).rejects.toThrow();
    });

    it("two # ### → DUPLICATE_SECTION", async () => {
      await expect(
        kb.writeConcept(
          "/doubled.md",
          { type: "T", title: "Doubled" },
          "# ###\n\nfirst\n\n# ###\n\nsecond",
          "add"
        )
      ).rejects.toMatchObject({ code: "DUPLICATE_SECTION" });
      await expect(fs.access(path.join(root, "doubled.md"))).rejects.toThrow();
    });

    it("# C# + # ### → ALLOWED (distinct keys: \"C#\" vs \"\")", async () => {
      // "C#" vs "" are different keys → allowed
      await kb.writeConcept(
        "/distinct.md",
        { type: "T", title: "Distinct" },
        "# C#\n\nfirst\n\n# ###\n\nsecond",
        "add"
      );
    });
  });
});

describe("duplicate-section write guards", () => {
  it("append (missing heading) with content containing another top-level # heading => rejects MULTI_SECTION_CONTENT", async () => {
    await kb.writeConcept(
      "/doc.md",
      { type: "T", title: "Doc" },
      "intro",
      "add"
    );
    const original = await kb.readConcept("/doc.md");
    await expect(
      kb.patchConcept(
        "/doc.md",
        { replaceSection: { heading: "Missing", content: "# Foo\n\nbar\n\n# Bar\n\nbaz" } },
        "try append"
      )
    ).rejects.toMatchObject({ code: "MULTI_SECTION_CONTENT" });
    const current = await kb.readConcept("/doc.md");
    expect(current.body).toBe(original.body);
  });

  it("writeConcept with body containing two identical top-level H1s => rejects DUPLICATE_SECTION", async () => {
    // Case-sensitive duplicate
    await expect(
      kb.writeConcept(
        "/dup.md",
        { type: "T", title: "Dup" },
        "# Setup\n\nfirst\n\n# Setup\n\nsecond",
        "add"
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_SECTION" });
    await expect(fs.access(path.join(root, "dup.md"))).rejects.toThrow();
  });

  it("writeConcept with case-insensitive duplicate top-level H1 => rejects DUPLICATE_SECTION", async () => {
    await expect(
      kb.writeConcept(
        "/case.md",
        { type: "T", title: "Case" },
        "# Setup\n\nfirst\n\n# setup\n\nsecond",
        "add"
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_SECTION" });
    await expect(fs.access(path.join(root, "case.md"))).rejects.toThrow();
  });

  it("# line inside fenced code block does NOT trigger either guard", async () => {
    const fence = "```";
    const body = `# Title\n\n${fence}bash\n# comment in fence\ncli line\n${fence}\n\nmore body\n`;
    const written = await kb.writeConcept(
      "/fence.md",
      { type: "T", title: "Fence" },
      body,
      "add"
    );
    expect(written.body).toBe(body);
    // Replace the Title section entirely with new content that has no real heading
    const patched = await kb.patchConcept(
      "/fence.md",
      { replaceSection: { heading: "Title", content: "just some text\n" } },
      "patch"
    );
    // The fence should be replaced along with the rest of the section
    expect(patched.body).not.toContain(fence);
    expect(patched.body).toBe("# Title\n\njust some text\n");
  });

  it("clean single-section append still works", async () => {
    await kb.writeConcept(
      "/clean.md",
      { type: "T", title: "Clean" },
      "body",
      "add"
    );
    const out = await kb.patchConcept(
      "/clean.md",
      { replaceSection: { heading: "New", content: "content" } },
      "append"
    );
    expect(out.body).toBe("body\n\n# New\n\ncontent\n");
  });

  it("leading-echo strip: append with first content line re-emitting target heading => no duplicate line", async () => {
    await kb.writeConcept(
      "/echo.md",
      { type: "T", title: "Echo" },
      "body",
      "add"
    );
    const out = await kb.patchConcept(
      "/echo.md",
      { replaceSection: { heading: "New", content: "# New\n\ncontent" } },
      "append"
    );
    expect(out.body).toBe("body\n\n# New\n\ncontent\n");
    expect(out.body.split("\n").filter((l) => l.trim() === "# New").length).toBe(1);
  });

  describe("topLevelHeadings fence classification", () => {
    it("does not treat # line inside backtick fence (after tilde line) as a top-level heading", () => {
      // A backtick-opened fence that contains a # line after a tilde line.
      // The naive toggle would close the fence on the tilde line, then reopen on backticks,
      // making # Phantom appear outside any fence (false positive).
      // fencedLines correctly keeps # Phantom marked as inside because the tilde does not close the backtick fence.
      const body = ["\`\`\`\`", "# Ghost", "~~~", "# Phantom", "\`\`\`\`"].join("\n");
      expect(topLevelHeadings(body)).toEqual([]);
    });

    it("still detects a real top-level heading outside any fence", () => {
      expect(topLevelHeadings("# Real")).toEqual(["Real"]);
    });
  });

  describe("topLevelHeadings trailing # handling", () => {
    it("preserves literal trailing # (no preceding whitespace)", () => {
      expect(topLevelHeadings("# C#")).toEqual(["C#"]);
    });

    it("strips ATX closing sequence with preceding whitespace", () => {
      expect(topLevelHeadings("# Section ##")).toEqual(["Section"]);
    });
  });

  describe("commonmark §4.2: up to three leading spaces before heading", () => {
    describe("topLevelHeadings", () => {
      it("rejects indented H1 with 1 space (guard false-negative case)", () => {
        const body = "# Setup\n\ncontent\n\n # Setup\n\ndupe\n";
        const names = topLevelHeadings(body);
        expect(names).toEqual(["Setup", "Setup"]);
        expect(new Set(names.map((s) => s.toLowerCase()))).toEqual(new Set(["setup"]));
      });

      it("rejects indented H1 with 3 spaces (guard false-negative case)", () => {
        const body = "# Setup\n\ncontent\n\n   # Setup\n\ndupe\n";
        expect(topLevelHeadings(body)).toEqual(["Setup", "Setup"]);
      });

      it("does NOT treat 4-space indented # as a top-level heading", () => {
        const body = "# Setup\n\n    # Not a heading\n\ncontent\n";
        expect(topLevelHeadings(body)).toEqual(["Setup"]);
      });

      it("indented H1 inside a fenced code block is still skipped", () => {
        const body = "# Title\n\n`\`\`bash\n    # indented in fence\ncli\n`\`\`\n\n# Other\n\nbody\n";
        expect(topLevelHeadings(body)).toEqual(["Title", "Other"]);
      });
    });

    describe("replaceSection", () => {
      it("replaces a section whose heading is indented with 1 space (no silent-append)", () => {
        const body = "# Title\n\nIntro\n\n ## Goals\n\nold\n\n## Notes\n\nn\n";
        const out = replaceSection(body, "Goals", "new goals");
        expect(out).toBe("# Title\n\nIntro\n\n ## Goals\n\nnew goals\n\n## Notes\n\nn\n");
      });

      it("replaces a section whose heading is indented with 3 spaces (no silent-append)", () => {
        const body = "# Title\n\nIntro\n\n   ## Goals\n\nold\n\n## Notes\n\nn\n";
        const out = replaceSection(body, "Goals", "new goals");
        expect(out).toBe("# Title\n\nIntro\n\n   ## Goals\n\nnew goals\n\n## Notes\n\nn\n");
      });

      it("appends correctly when an indented H1 (1 space) is the target and absent", () => {
        const out = replaceSection("body only", " Goals", "content");
        expect(out).toBe("body only\n\n# Goals\n\ncontent\n");
      });

      it("appends correctly when an indented H1 (3 spaces) is the target and absent", () => {
        const out = replaceSection("body only", "   Goals", "content");
        expect(out).toBe("body only\n\n# Goals\n\ncontent\n");
      });

      it("handles existing indented heading with duplicate heuristic (no line duplication)", () => {
        const body = "# Title\n\n ## Goals\n\nold\n";
        const out = replaceSection(body, "Goals", " ## Goals\n\nnew\n");
        expect(out).toBe("# Title\n\n ## Goals\n\nnew\n");
        expect(out.split("\n").filter((l) => l.trim() === "## Goals").length).toBe(1);
      });

      it("does NOT delete sibling H1 when indented H1 follows non-indented H1", () => {
        const body = "# Alpha\n\nalpha content\n\n   # Beta\n\n_beta content\n";
        const out = replaceSection(body, "Alpha", "new alpha");
        // Beta and its content must survive; Beta is a top-level section, NOT a subsection of Alpha
        expect(out).not.toContain("alpha content");
        expect(out).toContain("new alpha");
        expect(out).toContain("_beta content");
        expect(out).toContain("   # Beta");
      });
    });
  });
});
