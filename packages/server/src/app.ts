import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express, type RequestHandler, type Router } from "express";
import cors from "cors";
import type { KnowledgeBase } from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import type { MemoryHost, ResolvedMemory } from "./host.js";

export interface AppOptions {
  /** Built web UI to serve, when present. */
  webDist?: string;
  /** Profile-management routes, mounted at /admin. */
  admin?: Router;
}

/**
 * The HTTP application: /mcp and /api are served from whichever memory the
 * host resolves the request to, so the same wiring covers one bundle and
 * many profiles.
 */
export function buildApp(host: MemoryHost, options: AppOptions = {}): Express {
  const app = express();

  // Reflect the request origin; expose Mcp-Session-Id so browser MCP clients can
  // read it back off the initialize response.
  app.use(
    cors({
      origin: true,
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: [
        "Content-Type",
        "Accept",
        "Authorization",
        "Mcp-Session-Id",
        "Mcp-Protocol-Version",
        "Last-Event-ID",
      ],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    })
  );
  app.use(express.json({ limit: "4mb" }));

  // Routers close over one KnowledgeBase, so build them once per memory and
  // dispatch each request to the set belonging to the memory it resolved to.
  const routers = new WeakMap<KnowledgeBase, { mcp: Router; api: Router }>();
  const routersFor = (kb: KnowledgeBase) => {
    let set = routers.get(kb);
    if (!set) {
      set = { mcp: mcpRouter(kb), api: express.Router().use(browseRouter(kb)).use(chatRouter(kb)) };
      routers.set(kb, set);
    }
    return set;
  };
  const memoryOf = (res: express.Response) => res.locals.memory as ResolvedMemory;

  const authenticate: RequestHandler = (req, res, next) => host.authenticate(req, res, next);

  app.use("/mcp", authenticate, (req, res, next) => routersFor(memoryOf(res).kb).mcp(req, res, next));

  // Which memory this caller is talking to — lets the UI label the profile.
  app.get("/api/profile", authenticate, (_req, res) => {
    res.json({ mode: host.mode, profile: memoryOf(res).profile });
  });
  app.use("/api", authenticate, (req, res, next) => routersFor(memoryOf(res).kb).api(req, res, next));

  if (options.admin) app.use("/admin", options.admin);

  // Serve the built web UI in production (single container), with SPA fallback.
  const webDist = options.webDist;
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/(api|mcp|admin)).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}
