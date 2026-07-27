import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { Bundle } from "./bundle.js";
import { pruneEmptyDirs, regenerateIndexChain } from "./indexer.js";
import { appendLog, readLog } from "./logger.js";
import { searchBundle, listTypes, type SearchOptions } from "./search.js";
import { validateBundle } from "./validate.js";
import { lintBundle, type LintReport } from "./lint.js";
import { buildGraph, type GraphData } from "./graph.js";
import type {
  Concept,
  ConceptFrontmatter,
  ConformanceReport,
  LogAction,
  LogEntry,
  SearchHit,
  TreeNode,
} from "./types.js";

export interface KnowledgeBaseOptions {
  /** Commit after each mutation. Requires the bundle to be inside a git repo. */
  gitAutocommit?: boolean;
}

/** A raw, untrusted capture awaiting constrained LLM curation. */
export interface InboxItem {
  id: string;
  path: string;
}

/**
 * The one write-path into the bundle. Spec conformance (index.md, log.md,
 * frontmatter validation, timestamps) is enforced HERE, deterministically —
 * never delegated to the LLM. Mutations are serialized through a queue.
 */
export class KnowledgeBase {
  readonly bundle: Bundle;
  private readonly git: SimpleGit | null;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(bundleRoot: string, private readonly options: KnowledgeBaseOptions = {}) {
    this.bundle = new Bundle(bundleRoot);
    this.git = options.gitAutocommit ? simpleGit(this.bundle.root) : null;
  }

  // ── Reads (no queue) ────────────────────────────────────────────────

  readConcept(conceptPath: string): Promise<Concept> {
    return this.bundle.readConcept(conceptPath);
  }

  listTree(): Promise<TreeNode> {
    return this.bundle.listTree();
  }

  search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return searchBundle(this.bundle, query, options);
  }

  listTypes(): Promise<string[]> {
    return listTypes(this.bundle);
  }

  readLog(): Promise<LogEntry[]> {
    return readLog(this.bundle);
  }

  validate(): Promise<ConformanceReport> {
    return validateBundle(this.bundle);
  }

  /** Graph health: orphaned concepts + broken links (deterministic, no LLM). */
  lint(): Promise<LintReport> {
    return lintBundle(this.bundle);
  }

  /** Inter-concept link graph (nodes + edges) for visualization. */
  graph(): Promise<GraphData> {
    return buildGraph(this.bundle);
  }

  // ── Deferred inbox (raw capture; never exposed as a concept) ─────────

  /** Store raw text immediately without invoking an LLM or mutating concepts. */
  captureInboxItem(content: string): Promise<InboxItem> {
    return this.enqueue(async () => {
      const id = `${Date.now()}-${randomUUID()}`;
      const item: InboxItem = { id, path: `/inbox/${id}.json` };
      const abs = this.bundle.resolve(item.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(
        abs,
        JSON.stringify({ id, capturedAt: new Date().toISOString(), content }) + "\n",
        "utf-8"
      );
      return item;
    });
  }

  /** List pending raw captures in capture order without exposing their text. */
  async listInboxItems(): Promise<InboxItem[]> {
    const inbox = this.bundle.resolve("/inbox");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(inbox, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((entry) => entry.isFile() && /^\d+-[a-f0-9-]+\.json$/.test(entry.name))
      .map((entry) => ({ id: entry.name.slice(0, -".json".length), path: `/inbox/${entry.name}` }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Read exactly one raw capture by generated ID. */
  async readInboxItem(id: string): Promise<string> {
    const abs = this.bundle.resolve(this.inboxPath(id));
    const raw = await fs.readFile(abs, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { content?: unknown }).content !== "string") {
      throw new Error(`Invalid inbox item: ${id}`);
    }
    return (parsed as { content: string }).content;
  }

  /** Move exactly one processed raw capture to the archive; never lets the LLM delete it. */
  archiveInboxItem(id: string): Promise<InboxItem> {
    return this.enqueue(async () => {
      const source = this.bundle.resolve(this.inboxPath(id));
      const archived: InboxItem = { id, path: `/archive/inbox/${id}.json` };
      const destination = this.bundle.resolve(archived.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      return archived;
    });
  }

  private inboxPath(id: string): string {
    if (!/^\d+-[a-f0-9-]+$/.test(id)) throw new Error(`Invalid inbox item ID: ${id}`);
    return `/inbox/${id}.json`;
  }

  // ── Mutations (serialized; auto index + log + optional commit) ──────

  writeConcept(
    conceptPath: string,
    frontmatter: ConceptFrontmatter,
    body: string,
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const existed = await this.bundle.exists(conceptPath);
      const concept = await this.bundle.writeConcept(conceptPath, frontmatter, body);
      await this.afterMutation(concept.path, existed ? "Update" : "Creation", logSummary);
      return concept;
    });
  }

  patchConcept(
    conceptPath: string,
    changes: Parameters<Bundle["patchConcept"]>[1],
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const concept = await this.bundle.patchConcept(conceptPath, changes);
      await this.afterMutation(concept.path, "Update", logSummary);
      return concept;
    });
  }

  deleteConcept(conceptPath: string, logSummary: string): Promise<void> {
    return this.enqueue(async () => {
      const canonical = this.bundle.toBundlePath(conceptPath);
      await this.bundle.deleteConcept(canonical);
      await this.afterMutation(canonical, "Deletion", logSummary);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  private async afterMutation(
    conceptPath: string,
    action: LogAction,
    logSummary: string
  ): Promise<void> {
    // Sweep husks first (dirs holding only their auto-generated index.md) so
    // the reindex below never resurrects a pruned directory. Whole-bundle:
    // cheap at this scale, and it also heals husks from before this feature.
    await pruneEmptyDirs(this.bundle);
    await regenerateIndexChain(this.bundle, path.posix.dirname(conceptPath));
    const linked = `[${conceptPath.split("/").pop()}](${conceptPath})`;
    await appendLog(this.bundle, action, logSummary || `${action} of ${linked}.`);
    if (this.git) {
      try {
        await this.git.add(".");
        await this.git.commit(`${action.toLowerCase()}: ${logSummary || conceptPath}`);
      } catch (err) {
        // Autocommit is best-effort; the KB write itself already succeeded.
        console.error(`[understory] git autocommit failed: ${(err as Error).message}`);
      }
    }
  }
}
