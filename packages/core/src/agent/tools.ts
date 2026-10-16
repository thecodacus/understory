import { tool } from "ai";
import { z } from "zod";
import type { KnowledgeBase } from "../okf/index.js";
import { findPlainObjectKeys } from "../okf/index.js";
import type { TreeNode } from "../okf/types.js";
import type { TraceRecorder } from "./trace.js";
import { recordHotDelete, recordHotWrite } from "./hot-memory.js";

/** Bundle-relative concept path, e.g. "/tables/customers.md". */
const conceptPath = z
  .string()
  .describe('Bundle-relative path starting with "/", ending in .md');

const frontmatterSchema = z
  .object({
    type: z.string().min(1).describe("Concept kind, e.g. 'API Endpoint'. Required."),
    title: z.string().optional(),
    description: z.string().optional().describe("One-line summary"),
    resource: z.string().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe("YAML frontmatter. Additional producer-defined keys are allowed.");

/**
 * Per-key frontmatter patch values (merge semantics): the key's expected scalar/list
 * type, or null to delete the key. Previously this was `z.record(z.unknown())`, which
 * let models serialize plain objects into YAML frontmatter and corrupt the bundle (#39).
 */
export const frontmatterPatchSchema = z
  .object({
    type: z.string().min(1).nullable().optional().describe("Concept kind, e.g. 'API Endpoint'"),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional().describe("One-line summary"),
    resource: z.string().nullable().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).nullable().optional(),
  })
  .passthrough()
  .refine(
    (v) => findPlainObjectKeys(v).length === 0,
    "Frontmatter values must be scalars or arrays of scalars, never plain objects (e.g. pass 'Description text', not { __type: 'string', __value: ... }). Set a key to null to remove it."
  )
  .describe(
    "Frontmatter keys to merge; set a key to null to remove it. Values must be strings, arrays of strings (for tags), or numbers — never objects." +
      " Producer-defined keys are allowed with the same value restrictions."
  );

const logSummary = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );

/**
 * Hits handed to the agent per search. Every hit is re-sent at every later step
 * of the run, so a wide result set is paid for repeatedly rather than once. The
 * agent judges relevance from `score` plus `snippet`, so it needs a short ranked
 * list, not the whole candidate pool. Set AGENT_SEARCH_LIMIT to widen it.
 */
const agentSearchLimit = (): number => Number(process.env.AGENT_SEARCH_LIMIT ?? 8) || 8;

export function buildReadTools(kb: KnowledgeBase, trace?: TraceRecorder) {
  let layoutCalls = 0;
  return {
    search_knowledge: tool({
      description:
        "Search the knowledge base by keywords, optionally filtered by concept type and/or tags. Returns ranked hits with paths and snippets. NOTE: matching is keyword-based, not semantic — a miss does NOT mean the knowledge is absent; it may be worded differently.",
      inputSchema: z.object({
        query: z.string().describe("Keywords to search for. May be empty when filtering by type/tags only."),
        type: z.string().optional().describe("Exact concept type filter"),
        tags: z.array(z.string()).optional().describe("Require ALL of these tags"),
      }),
      execute: async ({ query, type, tags }) => {
        // An empty query with no filters is browse mode: every concept scores the
        // same and the result is an arbitrary slice of the bundle that looks
        // exactly like a hit. In a retrieval loop the agent reads that as success
        // and keeps going, so refuse it and name the two things that help.
        if (!query.trim() && !type && !tags?.length) {
          trace?.record("search_knowledge", "", []);
          return {
            hits: [],
            notice:
              "An empty query with no type or tag filters is not a search — it would return arbitrary concepts, not answers. Search with keywords, or use list_directory to see what exists.",
          };
        }
        const hits = await kb.search(query, { type, tags, limit: agentSearchLimit() });
        trace?.record("search_knowledge", query, hits.map((h) => h.path));
        if (hits.length > 0) return hits;
        // A keyword miss is information about wording, not proof of absence — but
        // the fix for that is a reworded search, not a full tree dump. The tree
        // was ~61,000 tokens on a 500-concept bundle, and it rode along in every
        // later step of the run while the agent was told to read anything
        // plausible. The layout is already in the system prompt; a miss needs a
        // nudge, not a second copy of the bundle.
        return {
          hits: [],
          notice:
            "No keyword matches — this search is literal, not semantic, so the knowledge may exist under different wording. Retry with 1-2 synonyms or broader terms. If a reworded search also fails, say the knowledge is not covered rather than reading concepts one by one.",
        };
      },
    }),
    read_concept: tool({
      description: "Read one concept document in full: frontmatter and markdown body.",
      inputSchema: z.object({ path: conceptPath }),
      execute: async ({ path }) => {
        const c = await kb.readConcept(path);
        trace?.record("read_concept", c.path, [c.path]);
        return { path: c.path, frontmatter: c.frontmatter, body: c.body };
      },
    }),
    list_directory: tool({
      description:
        "List the bundle's directory tree with concept types/titles/descriptions. Use to understand structure and decide where new concepts belong.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("list_directory", "", []);
        layoutCalls++;
        // The full tree is ~61,000 tokens on a 500-concept bundle and stays in
        // the transcript for every later step of the run. One look is a
        // legitimate question; a second one is an orientation habit turning into
        // a token spiral, and the compact map is already in the instructions.
        if (layoutCalls > 1) {
          return {
            notice:
              "The layout has already been listed once in this run, and the compact map is in your instructions. Use them, then search with different wording rather than re-listing the bundle.",
          };
        }
        return formatTree(await kb.listTree());
      },
    }),
    lint_knowledge: tool({
      description:
        "Graph health check: orphaned concepts (nothing links to them) and broken links. Use to find what needs wiring into the graph or fixing.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("lint_knowledge", "", []);
        return kb.lint();
      },
    }),
  };
}

export function buildWriteTools(kb: KnowledgeBase, filesChanged: Set<string>, trace?: TraceRecorder) {
  return {
    write_concept: tool({
      description:
        "Create a new concept or fully overwrite an existing one. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: frontmatterSchema,
        body: z.string().describe("Markdown body (no frontmatter block)"),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, body, log_summary }) => {
        const c = await kb.writeConcept(path, frontmatter, body, log_summary);
        filesChanged.add(c.path);
        recordHotWrite(kb, c.path);
        trace?.record("write_concept", c.path, [c.path], true);
        return { written: c.path };
      },
    }),
    patch_concept: tool({
      description:
        "Targeted update of an existing concept: merge frontmatter keys (null deletes a key) and/or replace one heading body section (any level, H1-H6). Prefer this over write_concept for small edits.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: frontmatterPatchSchema.optional(),
        replace_section: z
          .object({
            heading: z
              .string()
              .min(1)
              .describe("Heading name (any level, # through ######), e.g. 'Schema'. Must be non-empty — to replace the whole body use replace_body instead."),
            content: z.string().describe("New content for that section"),
          })
          .optional(),
        replace_body: z
          .string()
          .optional()
          .describe("Replace the entire markdown body (frontmatter untouched). Use for restructuring; prefer replace_section for targeted edits."),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, replace_section, replace_body, log_summary }) => {
        const c = await kb.patchConcept(
          path,
          {
            frontmatter,
            replaceSection: replace_section
              ? { heading: replace_section.heading, content: replace_section.content }
              : undefined,
            replaceBody: replace_body,
          },
          log_summary
        );
        filesChanged.add(c.path);
        recordHotWrite(kb, c.path);
        trace?.record("patch_concept", c.path, [c.path], true);
        return { patched: c.path };
      },
    }),
    delete_concept: tool({
      description:
        "Permanently delete a concept file. Prefer deprecation (tag 'deprecated' via patch_concept) unless content is wrong/harmful or deletion was explicitly requested.",
      inputSchema: z.object({
        path: conceptPath,
        log_summary: logSummary,
      }),
      execute: async ({ path, log_summary }) => {
        await kb.deleteConcept(path, log_summary);
        filesChanged.add(path);
        recordHotDelete(kb, path);
        trace?.record("delete_concept", path, [path], true);
        return { deleted: path };
      },
    }),
  };
}

/** Compact indented listing for prompts and the list_directory tool. */
export function formatTree(node: TreeNode, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      lines.push(`${indent}${child.name}/`);
      lines.push(formatTree(child, depth + 1));
    } else if (child.kind === "concept") {
      const meta = [child.type, child.description].filter(Boolean).join(" — ");
      lines.push(`${indent}${child.name}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Directory-level filing map: where concepts live, how many, and which types are
 * in use there. The indented full tree costs ~61,000 tokens on a 500-concept
 * bundle and was re-sent on every step of every run, because prompt context is
 * re-sent, not streamed once. This carries the decision-relevant part of the map
 * at a small fraction of the price; list_directory still returns full detail.
 *
 * `maxDepth` bounds how deep the map goes. A query only needs to know which
 * areas exist, so it gets depth 1; a mutation needs the nested map to choose
 * where to file.
 */
export function formatTreeCompact(node: TreeNode, maxDirs = 80, maxDepth = Infinity): string {
  const count = (n: TreeNode): number =>
    n.kind === "concept" ? 1 : (n.children ?? []).reduce((a, c) => a + count(c), 0);
  const typesIn = (n: TreeNode, acc: Set<string> = new Set()): Set<string> => {
    if (n.kind === "concept" && n.type) acc.add(n.type);
    for (const c of n.children ?? []) typesIn(c, acc);
    return acc;
  };
  const lines: string[] = [];
  const walk = (n: TreeNode, prefix: string, depth: number) => {
    if (depth >= maxDepth) return;
    for (const c of n.children ?? []) {
      if (c.kind !== "directory") continue;
      const p = `${prefix}/${c.name}`;
      const total = count(c);
      if (total === 0) continue;
      const t = [...typesIn(c)].slice(0, 4);
      lines.push(`${p}/ — ${total} concept${total === 1 ? "" : "s"}${t.length ? ` (${t.join(", ")})` : ""}`);
      walk(c, p, depth + 1);
    }
  };
  walk(node, "", 0);
  return lines.slice(0, maxDirs).join("\n");
}
