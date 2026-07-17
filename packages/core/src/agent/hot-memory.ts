import type { KnowledgeBase } from "../okf/index.js";
import { parseDuration } from "../util/duration.js";
import type { AgentOptions } from "./agent.js";

/**
 * Hot memory: a small working set of recently written concepts and recent
 * Q&A pairs. Queries consult it BEFORE the deep agent run — one cheap,
 * tool-free LLM call over a tiny context. Misses fall through to deep
 * memory (the full agent loop). Short-term memory in front of long-term.
 *
 * Staleness rules:
 * - Hot concepts are stored as PATHS and read fresh at lookup — never stale.
 * - Hot Q&A pairs are purged on any write (the write may contradict them).
 * - Everything expires after HOT_MEMORY_TTL (default 1h).
 */

interface HotQA {
  question: string;
  answer: string;
  at: number;
}

const MAX_CONCEPTS = 10;
const MAX_QAS = 10;
const DEFAULT_TTL_MS = 3_600_000;
const MAX_EXCERPT_CHARS = 1500;

// Module-level: survives per-request McpServer instances (stateless HTTP).
const hotConcepts = new Map<string, number>(); // path → touchedAt
let hotQAs: HotQA[] = [];

/** Called by the write tools after any concept write/patch. */
export function recordHotWrite(path: string): void {
  hotConcepts.delete(path);
  hotConcepts.set(path, Date.now());
  while (hotConcepts.size > MAX_CONCEPTS) {
    const oldest = hotConcepts.keys().next().value;
    if (oldest === undefined) break;
    hotConcepts.delete(oldest);
  }
  // A write may contradict previous answers — drop them.
  hotQAs = [];
}

/** Called on deletes: the concept leaves the hot set; answers may be stale. */
export function recordHotDelete(path: string): void {
  hotConcepts.delete(path);
  hotQAs = [];
}

/** Called after a deep query completes. */
export function recordHotQuery(question: string, answer: string): void {
  hotQAs.push({ question, answer, at: Date.now() });
  if (hotQAs.length > MAX_QAS) hotQAs = hotQAs.slice(-MAX_QAS);
}

/** Test hook. */
export function clearHotMemory(): void {
  hotConcepts.clear();
  hotQAs = [];
}

export type HotGenerate = (
  system: string,
  prompt: string,
  options: AgentOptions
) => Promise<string>;

/**
 * Try to answer from the hot set. Returns the answer, or null when hot
 * memory is empty/expired/disabled or can't answer confidently (the model
 * must reply UNKNOWN in that case, which falls through to deep memory).
 */
export async function hotLookup(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {},
  // Injectable for tests.
  generate: HotGenerate = defaultGenerate
): Promise<string | null> {
  if (process.env.HOT_MEMORY === "false") return null;
  const ttl = parseDuration(process.env.HOT_MEMORY_TTL) ?? DEFAULT_TTL_MS;
  const cutoff = Date.now() - ttl;

  const sections: string[] = [];

  for (const [path, touchedAt] of hotConcepts) {
    if (touchedAt < cutoff) continue;
    try {
      const c = await kb.readConcept(path); // fresh read — never stale
      const fm = c.frontmatter;
      sections.push(
        `CONCEPT ${c.path}${fm.title ? ` — ${fm.title}` : ""}${fm.description ? ` (${fm.description})` : ""}\n` +
          c.body.slice(0, MAX_EXCERPT_CHARS)
      );
    } catch {
      hotConcepts.delete(path); // deleted behind our back
    }
  }
  for (const qa of hotQAs) {
    if (qa.at < cutoff) continue;
    sections.push(`PREVIOUS Q&A\nQ: ${qa.question}\nA: ${qa.answer}`);
  }

  if (sections.length === 0) return null;

  const system =
    `You answer questions using ONLY the recent-memory excerpts provided. ` +
    `These are the most recently touched pieces of a larger knowledge base. ` +
    `If they fully and confidently answer the question, answer concisely (and ` +
    `cite concept paths when you used them). If they do NOT contain enough to ` +
    `answer confidently, reply with exactly: UNKNOWN`;
  const prompt = `RECENT MEMORY:\n\n${sections.join("\n\n---\n\n")}\n\nQUESTION: ${question}`;

  const text = (await generate(system, prompt, options)).trim();
  if (!text || /^UNKNOWN\b/i.test(text)) return null;
  return text;
}

/**
 * One tool-free generation. Provider access is feature-detected so this file
 * works with both the current provider API (resolveModel) and the upcoming
 * generic-slots API (resolveModelConfig/createModel) without edits.
 */
const defaultGenerate: HotGenerate = async (system, prompt, options) => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const providers: any = await import("../providers/index.js");
  let model;
  if (typeof providers.resolveModel === "function") {
    model = await providers.resolveModel((options as any).provider, options.model);
  } else {
    const cfg = providers.resolveModelConfig(process.env);
    model = await providers.createModel(options.model ? { ...cfg, model: options.model } : cfg);
  }
  const { generateText } = await import("ai");
  const result = await generateText({ model, system, prompt, temperature: 0 });
  return result.text;
};
