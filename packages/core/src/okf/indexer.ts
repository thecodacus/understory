import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Bundle } from "./bundle.js";

/**
 * Regenerate a directory's index.md per spec §6:
 * bullet list of `[Title](relative-url) - description`, subdirectories included.
 * The root index.md carries the only frontmatter allowed in an index: okf_version.
 */
export async function regenerateIndex(bundle: Bundle, dir = "/"): Promise<string> {
  const absDir = bundle.resolve(dir);
  const isRoot = absDir === bundle.root;
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  const conceptLines: string[] = [];
  const dirLines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const summary = await summarizeDirectory(path.join(absDir, entry.name));
      dirLines.push(`* [${entry.name}](${entry.name}/) - ${summary}`);
      continue;
    }
    if (!entry.name.endsWith(".md") || RESERVED_FILENAMES.has(entry.name)) continue;
    let title = entry.name.replace(/\.md$/, "");
    let description = "";
    try {
      const { frontmatter } = parseDoc(
        await fs.readFile(path.join(absDir, entry.name), "utf-8")
      );
      if (typeof frontmatter.title === "string" && frontmatter.title) title = frontmatter.title;
      if (typeof frontmatter.description === "string") description = frontmatter.description;
    } catch {
      // Permissive: index unparseable files by filename.
    }
    conceptLines.push(`* [${title}](${entry.name})${description ? ` - ${description}` : ""}`);
  }

  const dirName = isRoot ? "Knowledge Base" : path.basename(absDir);
  const sections: string[] = [];
  if (isRoot) sections.push(`---\nokf_version: "0.1"\n---\n`);
  sections.push(`# ${capitalize(dirName)}\n`);
  if (conceptLines.length > 0) sections.push(conceptLines.join("\n") + "\n");
  if (dirLines.length > 0) {
    const heading = isRoot ? "Memory Segments" : "Subdirectories";
    sections.push(`## ${heading}\n\n${dirLines.join("\n")}\n`);
  }

  const content = sections.join("\n");
  await fs.writeFile(path.join(absDir, "index.md"), content, "utf-8");
  return content;
}

/** Regenerate index.md for a directory and every ancestor up to the root. */
export async function regenerateIndexChain(bundle: Bundle, dir: string): Promise<void> {
  let current = bundle.resolve(dir);
  // If given a file path, start from its directory.
  if (current.endsWith(".md")) current = path.dirname(current);
  // The directory may have been pruned away — start from the nearest ancestor
  // that still exists (the root always exists).
  while (current !== bundle.root) {
    try {
      await fs.access(current);
      break;
    } catch {
      current = path.dirname(current);
    }
  }
  while (true) {
    await regenerateIndex(bundle, bundle.toBundlePath(current));
    if (current === bundle.root) break;
    current = path.dirname(current);
  }
}

/**
 * Remove directories whose only content is the auto-generated index.md
 * (issue #10: agents move/merge concepts and leave undeletable husks —
 * delete_concept refuses reserved filenames by design, so cleanup must be
 * deterministic). Bottom-up over the whole bundle; a directory emptied by
 * pruning its children is pruned too. The root and dot-directories
 * (.traces etc.) are never touched. Returns removed bundle paths.
 */
export async function pruneEmptyDirs(bundle: Bundle): Promise<string[]> {
  const removed: string[] = [];

  async function visit(absDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await visit(path.join(absDir, entry.name));
      }
    }
    if (absDir === bundle.root) return;
    // Re-read: children may have been pruned during the recursion above.
    const remaining = await fs.readdir(absDir);
    const onlyIndex =
      remaining.length === 0 || (remaining.length === 1 && remaining[0] === "index.md");
    if (onlyIndex) {
      await fs.rm(absDir, { recursive: true, force: true });
      removed.push(bundle.toBundlePath(absDir));
    }
  }

  await visit(bundle.root);
  return removed;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One-line deterministic summary of a directory's contents for index listings:
 * concept count, distinct types, and the first few titles — always derivable,
 * always current, no LLM.
 */
async function summarizeDirectory(absDir: string): Promise<string> {
  const titles: string[] = [];
  const types = new Set<string>();
  let count = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.name.endsWith(".md") && !RESERVED_FILENAMES.has(entry.name)) {
        count++;
        try {
          const { frontmatter } = parseDoc(await fs.readFile(child, "utf-8"));
          if (typeof frontmatter.type === "string" && frontmatter.type) types.add(frontmatter.type);
          if (titles.length < 3) {
            titles.push(
              typeof frontmatter.title === "string" && frontmatter.title
                ? frontmatter.title
                : entry.name.replace(/\.md$/, "")
            );
          }
        } catch {
          if (titles.length < 3) titles.push(entry.name.replace(/\.md$/, ""));
        }
      }
    }
  };
  await walk(absDir);

  if (count === 0) return "empty";
  const typeList = [...types].sort().join(", ");
  const titleList = titles.join(", ") + (count > titles.length ? ", …" : "");
  return `${count} concept${count === 1 ? "" : "s"}${typeList ? ` (${typeList})` : ""}: ${titleList}`;
}
