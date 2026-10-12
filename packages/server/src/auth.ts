import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** The bearer token a request presented, or "" when there is none. */
export function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Constant-time comparison of a presented token against the expected one. */
export function tokenMatches(provided: string, expected: string): boolean {
  if (!provided) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * Optional bearer-token auth for /mcp and /api (issue #1).
 * AUTH_TOKEN unset → no auth (localhost/homelab default).
 * AUTH_TOKEN set   → requests must carry `Authorization: Bearer <token>`.
 * The static web UI stays open; it prompts for the token and sends it on
 * its API calls. The stdio MCP transport is unaffected (local process).
 */
export function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (tokenMatches(bearerToken(req), token)) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="understory"')
      .json({ error: "unauthorized: set Authorization: Bearer <AUTH_TOKEN>", mode: "single" });
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
