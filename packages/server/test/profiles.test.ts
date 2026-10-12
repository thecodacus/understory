import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "@understory/core";
import { adminRouter } from "../src/admin.js";
import { buildApp } from "../src/app.js";
import { profileMemoryHost, singleMemoryHost } from "../src/host.js";
import { ProfileError, ProfileRegistry } from "../src/profiles.js";

let root: string;
let registry: ProfileRegistry;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-profiles-"));
  registry = new ProfileRegistry(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ProfileRegistry", () => {
  it("creates a profile with its own bundle directory and resolves it by key", async () => {
    const { key } = await registry.create("work");
    expect(key).toMatch(/^usk_[A-Za-z0-9_-]{32}$/);
    await expect(fs.stat(path.join(root, "work"))).resolves.toBeTruthy();

    const resolved = await registry.resolve(key);
    expect(resolved?.name).toBe("work");
    expect(resolved?.kb.bundle.root).toBe(path.join(root, "work"));
  });

  it("stores only a hash of the key, in an owner-only file", async () => {
    const { key } = await registry.create("work");
    const file = path.join(root, "profiles.json");
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).not.toContain(key);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects unknown, empty and near-miss keys", async () => {
    const { key } = await registry.create("work");
    expect(await registry.resolve("")).toBeNull();
    expect(await registry.resolve("usk_nope")).toBeNull();
    expect(await registry.resolve(key.slice(0, -1))).toBeNull();
    expect(await registry.resolve(key + "x")).toBeNull();
  });

  it("rejects names that could escape or collide with the registry", async () => {
    for (const name of ["", "../evil", "a/b", "profiles.json", ".hidden", "Work", "a b", "x".repeat(64)]) {
      await expect(registry.create(name)).rejects.toMatchObject({ code: "INVALID_NAME" });
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses duplicate names", async () => {
    await registry.create("work");
    await expect(registry.create("work")).rejects.toMatchObject({ code: "EXISTS" });
  });

  it("returns the same KnowledgeBase instance for a profile every time", async () => {
    const { key } = await registry.create("work");
    const first = await registry.resolve(key);
    const second = await registry.resolve(key);
    // One instance = one mutation queue; two would let writes interleave.
    expect(second?.kb).toBe(first?.kb);
  });

  it("rotating a key invalidates the old one and keeps the memory", async () => {
    const { key: oldKey } = await registry.create("work");
    const kb = (await registry.resolve(oldKey))!.kb;
    await kb.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "alpha", "add");

    const { key: newKey } = await registry.rotate("work");
    expect(newKey).not.toBe(oldKey);
    expect(await registry.resolve(oldKey)).toBeNull();
    const after = await registry.resolve(newKey);
    expect((await after!.kb.readConcept("/facts/a.md")).body).toContain("alpha");
  });

  it("removing revokes the key but keeps the memory unless purged", async () => {
    const { key } = await registry.create("work");
    await (await registry.resolve(key))!.kb.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "alpha", "add");

    await registry.remove("work");
    expect(await registry.resolve(key)).toBeNull();
    await expect(fs.stat(path.join(root, "work/facts/a.md"))).resolves.toBeTruthy();

    // Creating it again adopts the directory that was left behind.
    const { key: again } = await registry.create("work");
    expect((await (await registry.resolve(again))!.kb.readConcept("/facts/a.md")).body).toContain("alpha");

    await registry.remove("work", { purge: true });
    await expect(fs.stat(path.join(root, "work"))).rejects.toThrow();
  });

  it("reports unknown profiles on rotate and remove", async () => {
    await expect(registry.rotate("ghost")).rejects.toBeInstanceOf(ProfileError);
    await expect(registry.remove("ghost")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("picks up changes made by another process (the CLI) without a restart", async () => {
    const { key } = await registry.create("work");
    expect((await registry.resolve(key))?.name).toBe("work");

    // A second registry on the same directory stands in for the CLI.
    const cli = new ProfileRegistry(root);
    const { key: personalKey } = await cli.create("personal");
    await cli.remove("work");

    expect((await registry.resolve(personalKey))?.name).toBe("personal");
    expect(await registry.resolve(key)).toBeNull();
  });

  it("fails closed when the registry file is corrupt", async () => {
    const { key } = await registry.create("work");
    await fs.writeFile(path.join(root, "profiles.json"), "{ not json");
    await expect(new ProfileRegistry(root).resolve(key)).rejects.toMatchObject({ code: "CORRUPT_REGISTRY" });
  });
});

describe("HTTP isolation between profiles", () => {
  let server: Server;
  let base: string;
  let workKey: string;
  let healthKey: string;
  const ADMIN = "admin-secret";

  const get = (url: string, key?: string) =>
    fetch(base + url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });

  beforeEach(async () => {
    workKey = (await registry.create("work")).key;
    healthKey = (await registry.create("health")).key;
    await (await registry.resolve(workKey))!.kb.writeConcept(
      "/facts/deploy.md",
      { type: "Fact", title: "Deploy day", description: "when we ship" },
      "We deploy on Fridays.",
      "add"
    );
    await (await registry.resolve(healthKey))!.kb.writeConcept(
      "/facts/allergy.md",
      { type: "Fact", title: "Allergy", description: "private medical note" },
      "Allergic to penicillin.",
      "add"
    );
    const app = buildApp(profileMemoryHost(registry), { admin: adminRouter(registry, ADMIN, async () => {}) });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires a profile key on /api and /mcp", async () => {
    expect((await get("/api/tree")).status).toBe(401);
    expect((await get("/api/tree", "usk_wrong")).status).toBe(401);
    expect((await get("/api/profile")).status).toBe(401);
    const mcp = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(401);
  });

  it("serves each key only its own memory", async () => {
    expect(await (await get("/api/profile", workKey)).json()).toEqual({ mode: "profiles", profile: "work" });
    expect(await (await get("/api/profile", healthKey)).json()).toEqual({ mode: "profiles", profile: "health" });

    const workTree = JSON.stringify(await (await get("/api/tree", workKey)).json());
    const healthTree = JSON.stringify(await (await get("/api/tree", healthKey)).json());
    expect(workTree).toContain("deploy.md");
    expect(workTree).not.toContain("allergy");
    expect(healthTree).toContain("allergy.md");
    expect(healthTree).not.toContain("deploy");
  });

  it("cannot reach another profile's concept by path, search or traversal", async () => {
    expect((await get("/api/concept?path=/facts/allergy.md", healthKey)).status).toBe(200);
    expect((await get("/api/concept?path=/facts/allergy.md", workKey)).status).toBe(404);
    const traversal = await get("/api/concept?path=" + encodeURIComponent("/../health/facts/allergy.md"), workKey);
    expect([400, 404]).toContain(traversal.status);
    expect(await traversal.text()).not.toContain("penicillin");

    const hits = await (await get("/api/search?q=penicillin", workKey)).json();
    expect(hits).toEqual([]);
  });

  it("gives each profile its own MCP seed overview", async () => {
    const initialize = (key: string) =>
      fetch(base + "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      }).then((r) => r.json() as Promise<{ result: { instructions: string } }>);

    const work = (await initialize(workKey)).result.instructions;
    const health = (await initialize(healthKey)).result.instructions;
    expect(work).toContain("when we ship");
    expect(work).not.toContain("private medical note");
    expect(health).toContain("private medical note");
    expect(health).not.toContain("when we ship");
  });

  it("keeps admin and profile credentials separate", async () => {
    // A profile key cannot manage profiles.
    expect((await get("/admin/profiles", workKey)).status).toBe(401);
    expect((await get("/admin/profiles")).status).toBe(401);
    // The admin token manages profiles but opens no memory.
    expect((await get("/api/tree", ADMIN)).status).toBe(401);
    const listed = (await (await get("/admin/profiles", ADMIN)).json()) as { name: string }[];
    expect(listed.map((p) => p.name).sort()).toEqual(["health", "work"]);
    expect(JSON.stringify(listed)).not.toContain("keyHash");
  });

  it("creates, rotates and revokes profiles through the admin API", async () => {
    const admin = (method: string, url: string, body?: unknown) =>
      fetch(base + url, {
        method,
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

    const created = await admin("POST", "/admin/profiles", { name: "research" });
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as { key: string };
    expect((await get("/api/tree", key)).status).toBe(200);

    expect((await admin("POST", "/admin/profiles", { name: "research" })).status).toBe(409);
    expect((await admin("POST", "/admin/profiles", { name: "../x" })).status).toBe(400);

    const rotated = (await (await admin("POST", "/admin/profiles/research/rotate")).json()) as { key: string };
    expect((await get("/api/tree", key)).status).toBe(401);
    expect((await get("/api/tree", rotated.key)).status).toBe(200);

    expect((await admin("DELETE", "/admin/profiles/research")).status).toBe(204);
    expect((await get("/api/tree", rotated.key)).status).toBe(401);
    expect((await admin("DELETE", "/admin/profiles/research")).status).toBe(404);
  });
});

describe("single-memory mode is unchanged", () => {
  let server: Server;
  let base: string;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const start = async (authToken: string | undefined) => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/facts/a.md", { type: "Fact", title: "A" }, "alpha", "add");
    server = buildApp(singleMemoryHost(kb, authToken)).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("is open without AUTH_TOKEN and has no /admin", async () => {
    await start(undefined);
    expect((await fetch(base + "/api/tree")).status).toBe(200);
    expect(await (await fetch(base + "/api/profile")).json()).toEqual({ mode: "single", profile: null });
    expect((await fetch(base + "/admin/profiles")).status).toBe(404);
  });

  it("requires AUTH_TOKEN when set", async () => {
    await start("s3cret");
    expect((await fetch(base + "/api/tree")).status).toBe(401);
    expect((await fetch(base + "/api/tree", { headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
  });
});
