#!/usr/bin/env node
/**
 * MCP over stdio — register in Claude Code / Claude Desktop:
 *   claude mcp add okf-kb -e BUNDLE_ROOT=/path/to/bundle -e OPENROUTER_API_KEY=... \
 *     -e LLM_PROVIDER=openrouter -- node <repo>/packages/server/dist/mcp/stdio.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase, resolveFallbackConfig, resolveModelConfig } from "@understory/core";
import { buildMcpServer } from "./server.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

// Validate LLM config at startup — fail fast with a clear error. stdio's
// only output channel to the user is stderr; stdout is reserved for the
// MCP protocol stream.
try {
  const primaryConfig = resolveModelConfig();
  console.error(
    `[understory] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.error(
      `[understory] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[understory] LLM configuration error: ${(err as Error).message}`);
  console.error("[understory] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
const server = await buildMcpServer(kb);
await server.connect(new StdioServerTransport());
// stdio transport keeps the process alive; logs must go to stderr only.
console.error(`[understory] serving bundle ${bundleRoot} over stdio`);
