import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDoc, serializeDoc, hasNonEmptyType, findPlainObjectKeys } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Concept, ConceptFrontmatter, TreeNode } from "./types.js";

/** Frontmatter keys the OKF spec defines; each holds a scalar or a list of strings. */
const STANDARD_KEYS = new Set(["type", "title", "description", "resource", "tags", "timestamp"]);

export class BundleError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "OUTSIDE_BUNDLE"
      | "RESERVED_NAME"
      | "NOT_FOUND"
      | "INVALID_FRONTMATTER"
      | "NOT_MARKDOWN"
      | "DUPLICATE_SECTION"
      | "MULTI_SECTION_CONTENT"
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * Filesystem access to one OKF bundle, sandboxed to its root directory.
 * All public methods take/return bundle-relative paths ("/dir/concept.md").
 */
export class Bundle {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a bundle-relative path to an absolute one, rejecting escapes. */
  resolve(bundlePath: string): string {
    // Already an OS-absolute path inside the bundle (e.g. from a directory walk).
    if (
      path.isAbsolute(bundlePath) &&
      (bundlePath === this.root || bundlePath.startsWith(this.root + path.sep))
    ) {
      return path.resolve(bundlePath);
    }
    const cleaned = bundlePath.replace(/^\/+/, "");
    const abs = path.resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new BundleError(`Path escapes bundle root: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    return abs;
  }

  /** Normalize any input to a canonical bundle-relative path starting with "/". */
  toBundlePath(inputPath: string): string {
    const abs = this.resolve(inputPath);
    const rel = path.relative(this.root, abs);
    return "/" + rel.split(path.sep).join("/");
  }

  private assertConceptPath(bundlePath: string): void {
    if (!bundlePath.endsWith(".md")) {
      throw new BundleError(`Concept paths must end in .md: ${bundlePath}`, "NOT_MARKDOWN");
    }
    const base = path.posix.basename(bundlePath);
    if (RESERVED_FILENAMES.has(base)) {
      throw new BundleError(
        `"${base}" is a reserved filename (index.md/log.md) and cannot be a concept`,
        "RESERVED_NAME"
      );
    }
  }

  async exists(bundlePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(bundlePath));
      return true;
    } catch {
      return false;
    }
  }

  async readConcept(bundlePath: string): Promise<Concept> {
    const canonical = this.toBundlePath(bundlePath);
    const abs = this.resolve(canonical);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
    const { frontmatter, body } = parseDoc(raw);
    return { path: canonical, frontmatter: frontmatter as ConceptFrontmatter, body, raw };
  }

  async readFileRaw(bundlePath: string): Promise<string> {
    const abs = this.resolve(bundlePath);
    try {
      return await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`File not found: ${bundlePath}`, "NOT_FOUND");
    }
  }

  async writeConcept(
    bundlePath: string,
    frontmatter: ConceptFrontmatter,
    body: string
  ): Promise<Concept> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    if (!hasNonEmptyType(frontmatter)) {
      throw new BundleError(
        `Frontmatter must include a non-empty "type" field (OKF spec §5)`,
        "INVALID_FRONTMATTER"
      );
    }
    // Plain objects in frontmatter serialize to typed/anonymous YAML structures that
    // break OKF conformance and crash consumers (e.g. the web UI). Scalars, arrays of
    // scalars and dates are fine; anything else is a caller bug.
    const objectKeys = await this.rejectedObjectKeys(canonical, frontmatter);
    if (objectKeys.length > 0) {
      throw new BundleError(
        `Frontmatter values must be scalars or arrays of scalars, not objects. Offending key(s): ${objectKeys.join(", ")}. ` +
          `Pass a plain string (or a list of strings for tags), or null to remove the key.`,
        "INVALID_FRONTMATTER"
      );
    }
    const stamped: ConceptFrontmatter = {
      ...frontmatter,
      timestamp: new Date().toISOString(),
    };
    // Last line of defense: no write may create a body with a duplicated
    // top-level section.
    const seenHeadings = new Set<string>();
    for (const h of topLevelHeadings(body)) {
      const k = h.toLowerCase();
      if (seenHeadings.has(k)) {
        throw new BundleError(
          `Write rejected: duplicate top-level section "${h}". One canonical section per heading — keep the newest content, merge any unique bullets into it, and retry the write.`,
          "DUPLICATE_SECTION"
        );
      }
      seenHeadings.add(k);
    }
    const abs = this.resolve(canonical);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializeDoc(stamped, body), "utf-8");
    return { path: canonical, frontmatter: stamped, body, raw: serializeDoc(stamped, body) };
  }

  /**
   * Frontmatter keys whose object values this write must not save.
   *
   * The standard OKF keys are scalars or string lists, so an object there is
   * always rejected. OKF also lets producers define their own keys, and a
   * bundle written elsewhere may hold structured ones (`owner: {team: ...}`).
   * Such a key is kept when it already exists in the file with exactly this
   * value, so patching or rewriting an imported concept does not destroy
   * metadata the write never touched. It can be carried forward, but not
   * created or altered here.
   */
  private async rejectedObjectKeys(
    canonical: string,
    frontmatter: ConceptFrontmatter
  ): Promise<string[]> {
    const objectKeys = findPlainObjectKeys(frontmatter);
    if (objectKeys.every((key) => STANDARD_KEYS.has(key))) return objectKeys;
    let existing: Record<string, unknown> = {};
    try {
      existing = (await this.readConcept(canonical)).frontmatter;
    } catch {
      // New or unreadable file: nothing to carry forward.
    }
    return objectKeys.filter(
      (key) => STANDARD_KEYS.has(key) || !isDeepStrictEqual(existing[key], frontmatter[key])
    );
  }

  /**
   * Targeted update: merge frontmatter keys (null deletes a key) and/or
   * replace the content under one heading (any level) "# Section".
   */
  async patchConcept(
    bundlePath: string,
    changes: {
      frontmatter?: Record<string, unknown>;
      replaceSection?: { heading: string; content: string };
      replaceBody?: string;
    }
  ): Promise<Concept> {
    const existing = await this.readConcept(bundlePath);
    const fm: ConceptFrontmatter = { ...existing.frontmatter };
    if (changes.frontmatter) {
      for (const [k, v] of Object.entries(changes.frontmatter)) {
        if (v === null) delete fm[k];
        else fm[k] = v;
      }
    }
    let body = changes.replaceBody ?? existing.body;
    if (changes.replaceSection) {
      body = replaceSection(body, changes.replaceSection.heading, changes.replaceSection.content);
    }
    return this.writeConcept(existing.path, fm, body);
  }

  async deleteConcept(bundlePath: string): Promise<void> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    const abs = this.resolve(canonical);
    try {
      await fs.unlink(abs);
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
  }

  /** All concept files (recursive), as bundle-relative paths. */
  async listConceptPaths(dir = "/"): Promise<string[]> {
    const out: string[] = [];
    await this.walk(this.resolve(dir), (abs, name) => {
      if (name.endsWith(".md") && !RESERVED_FILENAMES.has(name)) {
        out.push(this.toBundlePath(abs));
      }
    });
    return out.sort();
  }

  /** Immediate subdirectories of a directory. */
  async listSubdirectories(dir = "/"): Promise<string[]> {
    const abs = this.resolve(dir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => this.toBundlePath(path.join(abs, e.name)))
      .sort();
  }

  async listTree(dir = "/"): Promise<TreeNode> {
    const abs = this.resolve(dir);
    const name = abs === this.root ? "/" : path.basename(abs);
    const node: TreeNode = {
      name,
      path: this.toBundlePath(abs),
      kind: "directory",
      children: [],
    };
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        node.children!.push(await this.listTree(this.toBundlePath(childAbs)));
      } else if (entry.name.endsWith(".md")) {
        if (RESERVED_FILENAMES.has(entry.name)) {
          node.children!.push({
            name: entry.name,
            path: this.toBundlePath(childAbs),
            kind: "reserved",
          });
        } else {
          let fmSummary: { type?: string; title?: string; description?: string } = {};
          try {
            const { frontmatter } = parseDoc(await fs.readFile(childAbs, "utf-8"));
            fmSummary = {
              type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
              title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
              description:
                typeof frontmatter.description === "string" ? frontmatter.description : undefined,
            };
          } catch {
            // Permissive: unparseable file still appears in the tree.
          }
          node.children!.push({
            name: entry.name,
            path: this.toBundlePath(childAbs),
            kind: "concept",
            ...fmSummary,
          });
        }
      }
    }
    return node;
  }

  private async walk(
    absDir: string,
    visit: (absPath: string, name: string) => void
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(absDir, entry.name);
      if (entry.isDirectory()) await this.walk(child, visit);
      else visit(child, entry.name);
    }
  }
}

/**
 * Top-level (H1) section names in a markdown body, skipping fenced code blocks.
 * Used to reject writes that duplicate a top-level section.
 */
export function topLevelHeadings(body: string): string[] {
  const names: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.*\S)\s*$/);
    if (m) names.push(m[1].replace(/#+\s*$/, "").trim());
  }
  return names;
}

/** Replace the content under a heading of any level; append a top-level
 * section if absent; throw on ambiguous (multiple) matches or if append
 * payload contains extra top-level sections. */
export function replaceSection(body: string, heading: string, content: string): string {
  const normalized = heading.replace(/^#+\s*/, "");
  const lines = body.split("\n");
  // A "# comment" inside a fenced code block is code, not a heading.
  const fenced = fencedLines(lines);
  const isHeading = (i: number) => !fenced[i] && /^#{1,6}\s+/.test(lines[i]);
  const level = (line: string) => line.match(/^#+/)![0].length;
  // Title without the leading hashes; an optional ATX closing sequence is
  // stripped only when preceded by whitespace (CommonMark §4.2 — "Goals##"
  // is the literal title "Goals##").
  const headingTitle = (line: string) =>
    line.replace(/^#{1,6}\s+/, "").trim().replace(/\s+#+$/, "");
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(i) && headingTitle(lines[i]) === normalized) {
      matches.push(i);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `replace_section: section "${normalized}" found ${matches.length} times — resolve duplicates via replace_body first.`
    );
  }
  const start = matches.length ? matches[0] : -1;

  // Normalize: strip a leading content line that duplicates the target heading.
  // This applies to both branches (found and append) to avoid silently duplicating
  // the section header when the model re-emits "# Heading" as its first line.
  const cLines = content.split("\n");
  const fi = cLines.findIndex((l) => l.trim().length > 0);
  if (fi >= 0 && /^#{1,6}\s+/.test(cLines[fi]) && headingTitle(cLines[fi]) === normalized) {
    content = cLines.slice(fi + 1).join("\n");
  }

  if (start === -1) {
    // This call appends exactly ONE section. Multi-section payloads silently
    // duplicate existing sections (the 2026-09-29 corruption class).
    const extra = topLevelHeadings(content);
    if (extra.length > 0) {
      throw new BundleError(
        `replace_section: content contains top-level section(s) ${JSON.stringify(extra)} — this call appends only "${normalized}". Pass single-section content, or use replace_body for a multi-section restructure.`,
        "MULTI_SECTION_CONTENT"
      );
    }
    const suffix = body.trim().length > 0 ? "\n\n" : "";
    return `${body.trimEnd()}${suffix}# ${normalized}\n\n${content.trim()}\n`;
  }
  const matchedLevel = level(lines[start]);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(i) && level(lines[i]) <= matchedLevel) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${content.trim()}\n${after ? "\n" + after : ""}`;
}

/** Marks the lines that sit inside a fenced code block, the fence lines included. */
function fencedLines(lines: string[]): boolean[] {
  let open: { char: string; length: number } | null = null;
  return lines.map((line) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open) {
      if (!fence) return false;
      open = { char: fence[1][0], length: fence[1].length };
      return true;
    }
    const closes =
      fence !== null && fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === "";
    if (closes) open = null;
    return true;
  });
}
