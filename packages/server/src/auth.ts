import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Optional bearer-token auth for /mcp and /api (issue #1).
 * AUTH_TOKEN unset → no auth (localhost/homelab default).
 * AUTH_TOKEN set   → requests must carry `Authorization: Bearer <token>`.
 * The static web UI stays open; it prompts for the token and sends it on
 * its API calls. The stdio MCP transport is unaffected (local process).
 */
export function bearerAuth(token: string) {
  const expected = sha256(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Hash both sides so timingSafeEqual gets equal-length buffers.
    if (provided && timingSafeEqual(sha256(provided), expected)) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="understory"')
      .json({ error: "unauthorized: set Authorization: Bearer <AUTH_TOKEN>" });
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
