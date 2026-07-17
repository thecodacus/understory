import type { KnowledgeBase } from "../okf/index.js";
import type { GraphNode } from "../okf/graph.js";
import { runMutation, type AgentOptions } from "./agent.js";

export interface DreamReport {
  ran: boolean;
  /** Why the dream was skipped (when ran=false). */
  reason?: string;
  summary?: string;
  filesChanged?: string[];
}

export interface DuplicateCandidate {
  a: string;
  b: string;
  similarity: number;
}

/**
 * Dreaming: an autonomous consolidation pass over the memory — what a brain
 * does during sleep. Deterministic signals decide whether there is anything
 * to dream about (orphans, broken links, likely duplicates, recent activity
 * worth abstracting); the agent then consolidates. No signals → no run, no
 * tokens.
 */
export async function runDream(
  kb: KnowledgeBase,
  options: AgentOptions = {},
  // Injectable for tests.
  runner: typeof runMutation = runMutation
): Promise<DreamReport> {
  const [lint, graph, log, fat] = await Promise.all([
    kb.lint(),
    kb.graph(),
    kb.readLog(),
    oversizedConcepts(kb),
  ]);
  const dupes = duplicateCandidates(graph.nodes);
  const insightsEnabled = process.env.DREAM_INSIGHTS !== "false";

  const signals: string[] = [];

  if (lint.orphans.length > 0) {
    signals.push(
      `ORPHANED CONCEPTS (nothing links to them). Read each and wire it into genuinely ` +
        `related concepts; if it relates to nothing, leave it alone:\n` +
        lint.orphans.map((o) => `- ${o.path}${o.title ? ` (${o.title})` : ""}`).join("\n")
    );
  }
  if (lint.brokenLinks.length > 0) {
    signals.push(
      `BROKEN LINKS (target missing). Fix the path if the target moved, remove the link if it is gone:\n` +
        lint.brokenLinks.map((b) => `- ${b.path} → ${b.target}`).join("\n")
    );
  }
  if (dupes.length > 0) {
    signals.push(
      `LIKELY DUPLICATES (title/description similarity). Read each pair; if they cover the ` +
        `same thing, merge the content into the better-placed concept, update anything that ` +
        `linked to the removed one, and delete the duplicate (deletion IS authorized for true ` +
        `duplicates after merging). If they are genuinely distinct, cross-link them instead:\n` +
        dupes.map((d) => `- ${d.a} ↔ ${d.b}`).join("\n")
    );
  }
  if (fat.length > 0) {
    signals.push(
      `OVERSIZED CONCEPTS (grown too large through repeated enrichment). For each: if the ` +
        `body contains genuinely separable topics, extract each into its OWN concept (proper ` +
        `type/title/description, back-linked per the rules), then rewrite the ORIGINAL file ` +
        `as a hub — a short summary that links to every extracted concept. NEVER delete or ` +
        `rename the original path; other concepts link to it. If the content is one ` +
        `indivisible topic, leave it alone:\n` +
        fat.map((f) => `- ${f.path} (${f.chars} chars, ${f.sections} sections)`).join("\n")
    );
  }
  if (insightsEnabled && log.length >= 5) {
    signals.push(
      `CONSOLIDATION (optional). Review the recent activity below. If several concepts now ` +
        `describe one theme that has no overview concept, create ONE overview concept that ` +
        `summarizes and links them (and back-link per the rules). If nothing meaningful ` +
        `emerges, skip this — do not force an insight.\n` +
        log.slice(0, 10).map((e) => `- ${e.date} ${e.action}: ${e.summary}`).join("\n")
    );
  }

  if (signals.length === 0) {
    return { ran: false, reason: "memory healthy — nothing to consolidate" };
  }

  const instruction =
    `DREAM: autonomous memory consolidation (maintenance run, no user waiting).\n\n` +
    signals.join("\n\n") +
    `\n\nWork through the applicable items above. Be conservative: prefer small, clearly ` +
    `justified edits over sweeping rewrites. Summarize exactly what changed.`;

  const result = await runner(kb, `${instruction}`, options);
  return { ran: true, ...normalizeMutation(result) };
}

/**
 * PR #5 changes runMutation's return shape from MutationResult to a
 * MutationOutcome union — accept both so this file needs no edits (and no
 * conflicts) whichever lands first.
 */
function normalizeMutation(result: unknown): { summary: string; filesChanged: string[] } {
  const r = result as Record<string, unknown>;
  if (r && typeof r === "object" && "ok" in r) {
    // MutationOutcome shape.
    if (r.ok === true) {
      const inner = r.result as { summary: string; filesChanged: string[] };
      return { summary: inner.summary, filesChanged: inner.filesChanged };
    }
    return {
      summary: `dream run failed: ${String(r.error ?? "unknown error")}`,
      filesChanged: Array.isArray(r.filesChanged) ? (r.filesChanged as string[]) : [],
    };
  }
  // MutationResult shape.
  const m = r as { summary?: string; filesChanged?: string[] };
  return { summary: m.summary ?? "", filesChanged: m.filesChanged ?? [] };
}

export interface OversizedConcept {
  path: string;
  chars: number;
  sections: number;
}

const SPLIT_CHARS = 6000;
const SPLIT_SECTIONS = 6;
const MAX_SPLITS_PER_DREAM = 3;

/**
 * Deterministic bloat detection — the counterpart of duplicate detection.
 * Enrich-over-create makes concepts grow forever; flag ones whose body is
 * very long or has sprouted many top-level sections, so the dream can split
 * them hub-and-spoke (original path preserved, so inbound links never break).
 */
export async function oversizedConcepts(kb: KnowledgeBase): Promise<OversizedConcept[]> {
  const paths = await kb.bundle.listConceptPaths();
  const out: OversizedConcept[] = [];
  for (const p of paths) {
    try {
      const c = await kb.readConcept(p);
      const sections = (c.body.match(/^#\s+/gm) ?? []).length;
      if (c.body.length >= SPLIT_CHARS || sections >= SPLIT_SECTIONS) {
        out.push({ path: p, chars: c.body.length, sections });
      }
    } catch {
      // Permissive: unreadable concepts are lint's problem, not the dream's.
    }
  }
  return out.sort((a, b) => b.chars - a.chars).slice(0, MAX_SPLITS_PER_DREAM);
}

/**
 * Deterministic duplicate detection: token-set similarity over title +
 * description. O(n²) — fine at personal-memory scale.
 */
export function duplicateCandidates(nodes: GraphNode[], threshold = 0.65): DuplicateCandidate[] {
  const tokenized = nodes
    .map((n) => ({ path: n.path, tokens: tokens(`${n.title ?? ""} ${n.description ?? ""}`) }))
    .filter((n) => n.tokens.size >= 2);
  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const similarity = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (similarity >= threshold) {
        out.push({ a: tokenized[i].path, b: tokenized[j].path, similarity });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, 5);
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
