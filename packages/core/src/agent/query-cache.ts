import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { KnowledgeBase } from "../okf/index.js";
import { parseDuration } from "../util/duration.js";
import { runQuery, type AgentOptions, type QueryResult } from "./agent.js";
import { hotLookup, recordHotQuery, type HotGenerate } from "./hot-memory.js";

export interface CachedQueryResult extends QueryResult {
  /** True when the answer came from the exact cache (no agent run, no trace). */
  cached: boolean;
  /** Which memory layer answered: exact cache, hot working set, or the deep agent. */
  source: "cache" | "hot" | "deep";
}

const MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 24 * 3_600_000;

interface CacheEntry {
  expiresAt: number;
  result: QueryResult;
}

// Module-level so the cache survives the per-request McpServer instances of
// the stateless HTTP transport.
const cache = new Map<string, CacheEntry>();

/**
 * Content fingerprint of the bundle: path + mtime + size of every concept
 * file. Any write moves the fingerprint, which implicitly invalidates every
 * cached answer — no hooks into the write path needed.
 */
export async function bundleFingerprint(kb: KnowledgeBase): Promise<string> {
  const paths = await kb.bundle.listConceptPaths();
  const parts = await Promise.all(
    paths.map(async (p) => {
      try {
        const st = await fs.stat(kb.bundle.resolve(p));
        return `${p}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${p}:gone`;
      }
    })
  );
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * runQuery with a fingerprint-invalidated LRU cache (issue-adjacent: repeated
 * questions are common through MCP, and local models make every agent run
 * expensive). Disabled with QUERY_CACHE=false; TTL via QUERY_CACHE_TTL
 * (e.g. "1h", default 24h). Cache hits skip the agent entirely, so they
 * record no trace.
 */
export async function runQueryCached(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {},
  // Injectable for tests.
  runner: typeof runQuery = runQuery,
  hot: (kb: KnowledgeBase, q: string, o: AgentOptions, g?: HotGenerate) => Promise<string | null> = hotLookup
): Promise<CachedQueryResult> {
  if (process.env.QUERY_CACHE === "false") {
    return { ...(await runner(kb, question, options)), cached: false, source: "deep" };
  }

  const fingerprint = await bundleFingerprint(kb);
  const key = createHash("sha256")
    .update(`${fingerprint}\n${normalize(question)}\n${options.model ?? ""}`)
    .digest("hex");

  // Layer 1: exact cache — same question, unchanged bundle.
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    // Refresh recency (Map preserves insertion order — delete + set = LRU touch).
    cache.delete(key);
    cache.set(key, hit);
    return { ...hit.result, cached: true, source: "cache" };
  }

  const ttl = parseDuration(process.env.QUERY_CACHE_TTL) ?? DEFAULT_TTL_MS;

  // Layer 2: hot working set — recently written concepts + recent answers,
  // one tool-free LLM call. A confident hot answer also lands in the exact
  // cache so identical repeats become instant.
  const hotAnswer = await hot(kb, question, options);
  if (hotAnswer !== null) {
    const result: QueryResult = { answer: hotAnswer, steps: 0, traceId: "" };
    store(key, result, ttl);
    return { ...result, cached: false, source: "hot" };
  }

  // Layer 3: deep memory — the full agent loop. Its answer feeds the hot set.
  const result = await runner(kb, question, options);
  store(key, result, ttl);
  recordHotQuery(question, result.answer);
  return { ...result, cached: false, source: "deep" };
}

function store(key: string, result: QueryResult, ttl: number): void {
  cache.set(key, { expiresAt: Date.now() + ttl, result });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test hook: reset module-level cache state. */
export function clearQueryCache(): void {
  cache.clear();
}

function normalize(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}
