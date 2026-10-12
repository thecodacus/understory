import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KnowledgeBase, clearHotMemory, type KnowledgeBaseOptions } from "@understory/core";

/**
 * Profiles: several isolated memories hosted by one server.
 *
 * Layout under PROFILES_ROOT:
 *   profiles.json      registry — name, SHA-256 of the API key, created date
 *   <name>/            that profile's OKF bundle
 *
 * The API key is the only thing that selects a memory: a request carrying
 * profile A's key is served by A's KnowledgeBase and can reach nothing else.
 * Keys are shown once at creation and stored only as hashes.
 */

export interface ProfileInfo {
  name: string;
  createdAt: string;
}

interface ProfileRecord extends ProfileInfo {
  keyHash: string;
}

interface RegistryFile {
  version: 1;
  profiles: ProfileRecord[];
}

export type ProfileErrorCode = "INVALID_NAME" | "EXISTS" | "NOT_FOUND" | "CORRUPT_REGISTRY";

export class ProfileError extends Error {
  constructor(message: string, readonly code: ProfileErrorCode) {
    super(message);
    this.name = "ProfileError";
  }
}

const REGISTRY_FILE = "profiles.json";
// Lowercase, no dots or slashes: a name is used verbatim as a directory.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KEY_PREFIX = "usk_";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function generateKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export class ProfileRegistry {
  readonly root: string;
  private records: ProfileRecord[] = [];
  private loadedStamp: string | null = null;
  // One KnowledgeBase per profile for the life of the process: its mutation
  // queue only serializes writes if every request shares the instance.
  private readonly kbs = new Map<string, KnowledgeBase>();

  constructor(root: string, private readonly kbOptions: KnowledgeBaseOptions = {}) {
    this.root = path.resolve(root);
  }

  private get file(): string {
    return path.join(this.root, REGISTRY_FILE);
  }

  bundlePath(name: string): string {
    return path.join(this.root, name);
  }

  /**
   * Re-read the registry if it changed on disk, so profiles created or
   * revoked with the CLI take effect on a running server without a restart.
   */
  async refresh(): Promise<void> {
    let stamp = "absent";
    try {
      const st = await fs.stat(this.file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // No registry yet: an empty set of profiles.
    }
    if (stamp === this.loadedStamp) return;

    let records: ProfileRecord[] = [];
    if (stamp !== "absent") {
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, "utf-8")) as RegistryFile;
        if (!Array.isArray(parsed.profiles)) throw new Error("missing profiles array");
        records = parsed.profiles;
      } catch (err) {
        // Fail closed: an unreadable registry authenticates nobody.
        throw new ProfileError(
          `profile registry ${this.file} is unreadable: ${(err as Error).message}`,
          "CORRUPT_REGISTRY"
        );
      }
    }
    this.records = records;
    this.loadedStamp = stamp;

    // Drop in-memory state for profiles that are gone.
    const live = new Set(records.map((r) => r.name));
    for (const [name, kb] of this.kbs) {
      if (!live.has(name)) this.forget(name, kb);
    }
  }

  private forget(name: string, kb: KnowledgeBase): void {
    clearHotMemory(kb);
    this.kbs.delete(name);
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const body: RegistryFile = { version: 1, profiles: this.records };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, this.file);
    const st = await fs.stat(this.file);
    this.loadedStamp = `${st.mtimeMs}:${st.size}`;
  }

  private kbFor(name: string): KnowledgeBase {
    let kb = this.kbs.get(name);
    if (!kb) {
      kb = new KnowledgeBase(this.bundlePath(name), this.kbOptions);
      this.kbs.set(name, kb);
    }
    return kb;
  }

  async list(): Promise<ProfileInfo[]> {
    await this.refresh();
    return this.records.map(({ name, createdAt }) => ({ name, createdAt }));
  }

  /** Every profile with its KnowledgeBase — for background work such as dreaming. */
  async memories(): Promise<{ name: string; kb: KnowledgeBase }[]> {
    await this.refresh();
    return this.records.map((r) => ({ name: r.name, kb: this.kbFor(r.name) }));
  }

  /**
   * Create a profile and return its API key (the only time it is available).
   * An existing directory of that name is adopted as the profile's bundle,
   * which is how a bundle from single-memory mode moves into a profile.
   */
  async create(name: string): Promise<{ name: string; key: string }> {
    if (!NAME_RE.test(name)) {
      throw new ProfileError(
        `invalid profile name "${name}": use lowercase letters, digits, "-" or "_" (max 63, starting with a letter or digit)`,
        "INVALID_NAME"
      );
    }
    await this.refresh();
    if (this.records.some((r) => r.name === name)) {
      throw new ProfileError(`profile "${name}" already exists`, "EXISTS");
    }
    await fs.mkdir(this.bundlePath(name), { recursive: true });
    const key = generateKey();
    this.records = [
      ...this.records,
      { name, keyHash: sha256(key).toString("hex"), createdAt: new Date().toISOString() },
    ];
    await this.save();
    return { name, key };
  }

  /** Issue a new key for a profile; the old key stops working immediately. */
  async rotate(name: string): Promise<{ name: string; key: string }> {
    await this.refresh();
    const record = this.records.find((r) => r.name === name);
    if (!record) throw new ProfileError(`profile "${name}" not found`, "NOT_FOUND");
    const key = generateKey();
    this.records = this.records.map((r) =>
      r.name === name ? { ...r, keyHash: sha256(key).toString("hex") } : r
    );
    await this.save();
    return { name, key };
  }

  /**
   * Revoke a profile's key. The memory itself stays on disk unless `purge`
   * is set, so removing access is never the same step as destroying data.
   */
  async remove(name: string, options: { purge?: boolean } = {}): Promise<void> {
    await this.refresh();
    if (!this.records.some((r) => r.name === name)) {
      throw new ProfileError(`profile "${name}" not found`, "NOT_FOUND");
    }
    this.records = this.records.filter((r) => r.name !== name);
    await this.save();
    const kb = this.kbs.get(name);
    if (kb) this.forget(name, kb);
    if (options.purge) {
      await fs.rm(this.bundlePath(name), { recursive: true, force: true });
    }
  }

  /** The profile a presented API key belongs to, or null. */
  async resolve(key: string): Promise<{ name: string; kb: KnowledgeBase } | null> {
    if (!key) return null;
    await this.refresh();
    const presented = sha256(key);
    let match: ProfileRecord | null = null;
    // Compare against every record so timing does not depend on which matched.
    for (const record of this.records) {
      const stored = Buffer.from(record.keyHash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = record;
    }
    return match ? { name: match.name, kb: this.kbFor(match.name) } : null;
  }
}
