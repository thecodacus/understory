import type { NextFunction, Request, Response } from "express";
import type { KnowledgeBase } from "@understory/core";
import { bearerAuth, bearerToken } from "./auth.js";
import { ProfileError, type ProfileRegistry } from "./profiles.js";

/** The memory a request was resolved to. `profile` is null in single-memory mode. */
export interface ResolvedMemory {
  kb: KnowledgeBase;
  profile: string | null;
}

/**
 * Where requests get their memory from. Two implementations:
 * one fixed bundle (BUNDLE_ROOT), or one bundle per API key (PROFILES_ROOT).
 */
export interface MemoryHost {
  readonly mode: "single" | "profiles";
  /** Authenticate the request and attach its memory as res.locals.memory, or answer 401. */
  authenticate(req: Request, res: Response, next: NextFunction): void;
  /** Every hosted memory, for background work such as dreaming. */
  memories(): Promise<ResolvedMemory[]>;
}

function unauthorized(res: Response, message: string): void {
  res.status(401).set("WWW-Authenticate", 'Bearer realm="understory"').json({ error: message });
}

/**
 * One bundle for everyone. AUTH_TOKEN unset → open (localhost/homelab
 * default); set → requests must carry `Authorization: Bearer <token>`.
 */
export function singleMemoryHost(kb: KnowledgeBase, authToken: string | undefined): MemoryHost {
  const memory: ResolvedMemory = { kb, profile: null };
  const guard = authToken ? bearerAuth(authToken) : null;
  return {
    mode: "single",
    authenticate(req, res, next) {
      const attach = () => {
        res.locals.memory = memory;
        next();
      };
      if (guard) guard(req, res, attach);
      else attach();
    },
    async memories() {
      return [memory];
    },
  };
}

/**
 * One bundle per profile. The bearer key is the only selector: it both
 * authenticates the caller and decides which memory they reach, so there is
 * no request parameter that could point one profile at another's data.
 */
export function profileMemoryHost(registry: ProfileRegistry): MemoryHost {
  return {
    mode: "profiles",
    authenticate(req, res, next) {
      registry
        .resolve(bearerToken(req))
        .then((resolved) => {
          if (!resolved) {
            unauthorized(res, "unauthorized: set Authorization: Bearer <profile API key>");
            return;
          }
          res.locals.memory = { kb: resolved.kb, profile: resolved.name } satisfies ResolvedMemory;
          next();
        })
        .catch((err: unknown) => {
          // An unreadable registry authenticates nobody.
          console.error(`[understory] ${(err as Error).message}`);
          const status = err instanceof ProfileError ? 503 : 500;
          res.status(status).json({ error: "profile registry unavailable" });
        });
    },
    async memories() {
      return (await registry.memories()).map(({ name, kb }) => ({ kb, profile: name }));
    },
  };
}
