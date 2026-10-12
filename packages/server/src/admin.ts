import express, { type Response, type Router } from "express";
import { bearerToken, tokenMatches } from "./auth.js";
import { ProfileError, type ProfileRegistry } from "./profiles.js";

function fail(res: Response, err: unknown): void {
  if (err instanceof ProfileError) {
    const status = { INVALID_NAME: 400, EXISTS: 409, NOT_FOUND: 404, CORRUPT_REGISTRY: 503, LOCKED: 503 }[err.code];
    res.status(status).json({ error: err.message });
    return;
  }
  throw err;
}

/**
 * Profile management over HTTP, guarded by ADMIN_TOKEN — a credential
 * separate from every profile key. The admin token manages profiles; it
 * cannot read or write any memory, and a profile key cannot reach /admin.
 */
export function adminRouter(
  registry: ProfileRegistry,
  adminToken: string,
  /** Run when a profile is created, before its key is handed out. */
  onCreated: (name: string) => Promise<void>
): Router {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!tokenMatches(bearerToken(req), adminToken)) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="understory-admin"')
        .json({ error: "unauthorized: set Authorization: Bearer <ADMIN_TOKEN>" });
      return;
    }
    next();
  });

  router.get("/profiles", async (_req, res) => {
    try {
      res.json(await registry.list());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/profiles", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    try {
      const created = await registry.create(name);
      try {
        await onCreated(created.name);
      } catch (err) {
        // The key has not been handed out yet, so a profile left behind here
        // could never be used and would block a retry under the same name.
        // Revoke it; any existing bundle directory is left untouched.
        await registry.remove(created.name).catch(() => {});
        const reason = (err as Error).message;
        console.error(`[understory] profile "${created.name}" was not created: ${reason}`);
        res.status(500).json({ error: `profile was not created: ${reason}` });
        return;
      }
      // The key is returned exactly once; only its hash is stored.
      res.status(201).json(created);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/profiles/:name/rotate", async (req, res) => {
    try {
      res.json(await registry.rotate(req.params.name));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/profiles/:name", async (req, res) => {
    try {
      await registry.remove(req.params.name, { purge: req.query.purge === "true" });
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
