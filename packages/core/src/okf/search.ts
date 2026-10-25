import type { Bundle } from "./bundle.js";
import type { Concept, SearchHit } from "./types.js";

const LINK_RE = /\]\((\/[^)#?\s]+\.md)\)/g;
export interface SearchOptions {
  type?: string;
  tags?: string[];
  limit?: number;
}

/**
 * Naive in-memory scan over all concepts — fine into the thousands of files.
 * Scores: title match > description/tag match > body match.
 */
const STOPWORDS: Record<string, true> = {
  an: true, as: true, at: true, be: true, by: true, do: true, if: true, in: true, is: true, it: true,
  no: true, of: true, on: true, or: true, so: true, to: true, we: true,
  all: true, and: true, any: true, are: true, but: true, can: true, did: true, for: true, get: true,
  had: true, has: true, how: true, its: true, not: true, now: true, our: true, out: true, say: true,
  see: true, the: true, too: true, use: true, was: true, who: true, why: true, you: true,
  does: true, from: true, have: true, into: true, just: true, more: true, over: true, says: true,
  some: true, than: true, that: true, them: true, then: true, they: true, this: true, what: true,
  when: true, will: true, with: true, work: true,
  about: true, could: true, other: true, their: true, there: true, these: true, those: true,
  using: true, where: true, which: true, works: true, would: true,
};

export async function searchBundle(
  bundle: Bundle,
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  const rawQuery = query.toLowerCase().trim();
  const phrases = [...new Set(rawQuery.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)+/g) ?? [])];
  let remainder = rawQuery;
  for (const p of phrases) remainder = remainder.split(p).join(" ");
  const standaloneTerms = remainder.split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS[t]);
  const phraseParts = phrases
    .flatMap((p) => p.split(/[^a-z0-9]+/))
    .filter((t) => t.length >= 4 && !STOPWORDS[t]);
  const terms = [...new Set([...standaloneTerms, ...phraseParts])];
  const paths = await bundle.listConceptPaths();
  const docs: Array<{
    path: string;
    concept: Concept;
    title: string;
    description: string;
    tags: string;
    body: string;
    pathLower: string;
    sourceLower: string;
  }> = [];
  for (const conceptPath of paths) {
    let concept: Concept;
    try {
      concept = await bundle.readConcept(conceptPath);
    } catch {
      continue; // Permissive: skip unreadable files.
    }
    const fm = concept.frontmatter;
    if (options.type && fm.type?.toLowerCase() !== options.type.toLowerCase()) continue;
    if (options.tags?.length) {
      const conceptTags = (Array.isArray(fm.tags) ? fm.tags : []).map((t) =>
        String(t).toLowerCase()
      );
      if (!options.tags.every((t) => conceptTags.includes(t.toLowerCase()))) continue;
    }
    docs.push({
      path: conceptPath,
      concept,
      title: (fm.title ?? "").toString().toLowerCase(),
      description: (fm.description ?? "").toString().toLowerCase(),
      tags: (Array.isArray(fm.tags) ? fm.tags : []).join(" ").toLowerCase(),
      body: concept.body.toLowerCase(),
      pathLower: conceptPath.toLowerCase(),
      sourceLower: (fm.source ?? "").toString().toLowerCase(),
    });
  }

  const totalDocs = docs.length || 1;
  const termIdf = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const d of docs) {
      if (
        d.title.includes(term) ||
        d.pathLower.includes(term) ||
        d.sourceLower.includes(term) ||
        d.description.includes(term) ||
        d.tags.includes(term) ||
        d.body.includes(term)
      ) {
        df++;
      }
    }
    // Robertson-Sparck Jones smoothed IDF bounded to [1, 4] so rare technical terms
    // outweigh ubiquitous corpus words without destabilizing single-doc tests.
    const idf = Math.min(4, Math.max(1, 1 + Math.log((totalDocs + 1) / (df + 1))));
    termIdf.set(term, idf);
  }

  const hitByPath = new Map<string, SearchHit>();
  for (const d of docs) {
    const { path: conceptPath, concept, title, description, tags, body, pathLower, sourceLower } = d;
    const fm = concept.frontmatter;
    let score = 0;
    let matchedUnits = 0;
    let firstBodyMatch = -1;
    for (const phrase of phrases) {
      let phraseHit = false;
      if (title.includes(phrase) || pathLower.includes(phrase) || sourceLower.includes(phrase)) {
        score += 25;
        phraseHit = true;
      }
      if (description.includes(phrase) || tags.includes(phrase)) {
        score += 20;
        phraseHit = true;
      }
      const pIdx = body.indexOf(phrase);
      if (pIdx !== -1) {
        score += 18;
        phraseHit = true;
        if (firstBodyMatch === -1) firstBodyMatch = pIdx;
      }
      if (phraseHit) matchedUnits++;
    }
    for (const term of terms) {
      const idf = termIdf.get(term) ?? 1;
      let termHit = false;
      if (title.includes(term)) { score += 10 * idf; termHit = true; }
      if (pathLower.includes(term) || sourceLower.includes(term)) { score += 6 * idf; termHit = true; }
      if (description.includes(term)) { score += 5 * idf; termHit = true; }
      if (tags.includes(term)) { score += 5 * idf; termHit = true; }
      const bodyIdx = body.indexOf(term);
      if (bodyIdx !== -1) {
        score += 2 * idf;
        termHit = true;
        if (firstBodyMatch === -1) firstBodyMatch = bodyIdx;
      }
      if (termHit) matchedUnits++;
    }
    if (matchedUnits >= 2) score += matchedUnits * 4;
    // Empty query with type/tag filters = browse mode: include everything that passed filters.
    if (rawQuery.length === 0) score = 1;
    if (score === 0) continue;

    hitByPath.set(conceptPath, {
      path: conceptPath,
      type: fm.type ?? "unknown",
      title: fm.title as string | undefined,
      description: fm.description as string | undefined,
      snippet:
        firstBodyMatch >= 0
          ? concept.body
              .slice(Math.max(0, firstBodyMatch - 60), firstBodyMatch + 120)
              .replace(/\s+/g, " ")
              .trim()
          : undefined,
      score: Math.round(score * 100) / 100,
    });
  }

  // 1-hop OKF link graph propagation: boost concepts directly linked from top lexical hits
  // (and surface linked hub/spoke concepts that use different vocabulary).
  if (rawQuery.length > 0 && hitByPath.size > 0) {
    const docByPath = new Map(docs.map((d) => [d.path, d]));
    const topSeeds = [...hitByPath.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((hit) => ({ path: hit.path, score: hit.score }));
    for (const seed of topSeeds) {
      const seedDoc = docByPath.get(seed.path);
      if (!seedDoc) continue;
      const hopBoost = Math.round(seed.score * 0.25 * 100) / 100;
      if (hopBoost < 2) continue;
      const targets = new Set(Array.from(seedDoc.concept.body.matchAll(LINK_RE), (m) => m[1]));
      for (const target of targets) {
        if (target === seed.path) continue;
        const existing = hitByPath.get(target);
        if (existing) {
          existing.score = Math.round((existing.score + hopBoost) * 100) / 100;
        } else {
          const targetDoc = docByPath.get(target);
          if (!targetDoc) continue;
          hitByPath.set(target, {
            path: target,
            type: targetDoc.concept.frontmatter.type ?? "unknown",
            title: targetDoc.concept.frontmatter.title as string | undefined,
            description: targetDoc.concept.frontmatter.description as string | undefined,
            snippet: targetDoc.concept.body.slice(0, 140).replace(/\s+/g, " ").trim() || undefined,
            score: hopBoost,
          });
        }
      }
    }
  }

  const hits = [...hitByPath.values()];
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, options.limit ?? 20);
}

/** Distinct `type` values in use across the bundle (fed to the agent's system prompt). */
export async function listTypes(bundle: Bundle): Promise<string[]> {
  const paths = await bundle.listConceptPaths();
  const types = new Set<string>();
  for (const p of paths) {
    try {
      const { frontmatter } = await bundle.readConcept(p);
      if (frontmatter.type) types.add(frontmatter.type);
    } catch {
      // skip
    }
  }
  return [...types].sort();
}
