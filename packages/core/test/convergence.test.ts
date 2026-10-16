import { describe, expect, it } from "vitest";
import { formatTree, formatTreeCompact } from "../src/agent/tools.js";
import type { TreeNode } from "../src/okf/types.js";

const tree: TreeNode = {
  kind: "directory",
  name: "",
  children: [
    {
      kind: "directory",
      name: "infrastructure",
      children: [
        { kind: "concept", name: "rig.md", type: "System" },
        {
          kind: "directory",
          name: "nested",
          children: [{ kind: "concept", name: "deep.md", type: "Tool" }],
        },
      ],
    },
    {
      kind: "directory",
      name: "agents",
      children: [{ kind: "concept", name: "keeper.md", type: "Memory" }],
    },
  ],
};

describe("filing map in prompts", () => {
  it("gives a query only the top level, which is all a read-only run needs", () => {
    const shallow = formatTreeCompact(tree, 60, 1);
    expect(shallow).toContain("/infrastructure/ — 2 concepts");
    expect(shallow).toContain("/agents/ — 1 concept");
    expect(shallow).not.toContain("/nested/");
  });

  it("still gives a mutation the nested map it needs to choose where to file", () => {
    expect(formatTreeCompact(tree)).toContain("/infrastructure/nested/ — 1 concept");
  });

  it("collapses many concepts per directory into one line — where the savings come from", () => {
    // On a handful of concepts the compact map is not shorter than the indented
    // tree, and pretending otherwise would be a lie in a test. The savings appear
    // at the size where a filing map stops being useful anyway: hundreds of
    // concepts, each of which the full tree names individually.
    const wide: TreeNode = {
      kind: "directory",
      name: "",
      children: Array.from({ length: 12 }, (_, d) => ({
        kind: "directory",
        name: `area${d}`,
        children: Array.from({ length: 25 }, (_, i) => ({
          kind: "concept",
          name: `concept-${d}-${i}.md`,
          type: "Note",
          description: `A description long enough that the full tree pays for it, concept ${i} of area ${d}`,
        })),
      })),
    };
    const compact = formatTreeCompact(wide).split("\n");
    const full = formatTree(wide).split("\n");
    expect(compact.length).toBe(12); // one line per directory
    expect(full.length).toBeGreaterThan(300); // every concept named
    expect(formatTreeCompact(wide).length).toBeLessThan(formatTree(wide).length / 10);
  });
});
