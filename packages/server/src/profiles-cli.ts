#!/usr/bin/env node
/**
 * Manage profiles from the command line. Operates on PROFILES_ROOT directly,
 * so it works next to a running server (which picks changes up on the next
 * request) and inside the container:
 *
 *   docker compose exec understory node server/dist/profiles-cli.js create work
 */
import { promises as fs } from "node:fs";
import { KnowledgeBase } from "@understory/core";
import { ProfileError, ProfileRegistry } from "./profiles.js";

const USAGE = `Usage: ustory-profiles <command>

  list                     Show profiles
  create <name>            Create a profile and print its API key (shown once)
  rotate <name>            Replace a profile's API key; the old key stops working
  remove <name> [--purge]  Revoke a profile's key. The memory stays on disk
                           unless --purge is given.

Reads PROFILES_ROOT from the environment.`;

const root = process.env.PROFILES_ROOT;
const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const [name] = rest.filter((a) => !a.startsWith("--"));

if (!command || command === "help" || command === "--help") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
if (!root) {
  console.error("PROFILES_ROOT is not set");
  process.exit(1);
}

const gitAutocommit = process.env.GIT_AUTOCOMMIT === "true";
const registry = new ProfileRegistry(root, { gitAutocommit });

function printKey(profile: string, key: string): void {
  console.log(`profile: ${profile}`);
  console.log(`api key: ${key}`);
  console.log("");
  console.log("Store this key now — it is not saved and cannot be shown again.");
  console.log(`Use it as:  Authorization: Bearer ${key}`);
}

try {
  switch (command) {
    case "list": {
      const profiles = await registry.list();
      if (profiles.length === 0) {
        console.log(`No profiles in ${registry.root}. Create one with: ustory-profiles create <name>`);
        break;
      }
      for (const p of profiles) {
        const concepts = await new KnowledgeBase(registry.bundlePath(p.name)).bundle
          .listConceptPaths()
          .then((paths) => paths.length, () => 0);
        console.log(`${p.name.padEnd(24)} ${String(concepts).padStart(5)} concepts   created ${p.createdAt.slice(0, 10)}`);
      }
      // Directories without a key: revoked profiles kept on disk, or bundles waiting to be adopted.
      const registered = new Set(profiles.map((p) => p.name));
      const entries = await fs.readdir(registry.root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !registered.has(entry.name)) {
          console.log(`${entry.name.padEnd(24)} (no key — "ustory-profiles create ${entry.name}" adopts this directory)`);
        }
      }
      break;
    }
    case "create": {
      if (!name) throw new ProfileError("create needs a profile name", "INVALID_NAME");
      const created = await registry.create(name);
      if (gitAutocommit) {
        const ready = await new KnowledgeBase(registry.bundlePath(name), { gitAutocommit }).ensureGitReady();
        if (!ready.ok) console.error(`warning: git autocommit cannot work for this profile: ${ready.reason}`);
      }
      printKey(created.name, created.key);
      break;
    }
    case "rotate": {
      if (!name) throw new ProfileError("rotate needs a profile name", "NOT_FOUND");
      const rotated = await registry.rotate(name);
      printKey(rotated.name, rotated.key);
      break;
    }
    case "remove": {
      if (!name) throw new ProfileError("remove needs a profile name", "NOT_FOUND");
      const purge = flags.has("--purge");
      await registry.remove(name, { purge });
      console.log(
        purge
          ? `Removed profile "${name}" and deleted its memory.`
          : `Revoked profile "${name}". Its memory is still at ${registry.bundlePath(name)} (use --purge to delete it).`
      );
      break;
    }
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      process.exit(1);
  }
} catch (err) {
  if (err instanceof ProfileError) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
