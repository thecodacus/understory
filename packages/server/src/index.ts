import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { KnowledgeBase, resolveFallbackConfig, resolveModelConfig } from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { bearerAuth } from "./auth.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

const app = express();

// Validate LLM config at startup — fail fast with a clear error.
try {
  const primaryConfig = resolveModelConfig();
  console.log(
    `[understory] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.log(
      `[understory] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[understory] LLM configuration error: ${(err as Error).message}`);
  console.error("[understory] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
  process.exit(1);
}

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

// Optional bearer auth (issue #1): protects the memory (/mcp + /api) when
// AUTH_TOKEN is set. Static web UI stays open and prompts for the token.
const authToken = process.env.AUTH_TOKEN;
if (authToken) {
  app.use(["/mcp", "/api"], bearerAuth(authToken));
  console.log("[understory] auth: bearer token required for /mcp and /api");
} else {
  console.log("[understory] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)");
}

app.use("/mcp", mcpRouter(kb));
app.use("/api", browseRouter(kb));
app.use("/api", chatRouter(kb));

// Serve the built web UI in production (single container), with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 3800);
app.listen(port, "0.0.0.0", () => {
  console.log(`understory serving bundle ${bundleRoot} on :${port} (web + /api + /mcp)`);
});
