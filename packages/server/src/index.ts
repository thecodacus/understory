import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeBase, resolveFallbackConfig, resolveLlmTimeout, resolveMaxSteps, resolveModelConfig } from "@understory/core";
import { adminRouter } from "./admin.js";
import { buildApp } from "./app.js";
import { startDreamer } from "./dreamer.js";
import { profileMemoryHost, singleMemoryHost, type MemoryHost } from "./host.js";
import { ProfileRegistry } from "./profiles.js";

const gitAutocommit = process.env.GIT_AUTOCOMMIT === "true";
// PROFILES_ROOT takes precedence: the Docker image always sets BUNDLE_ROOT.
const profilesRoot = process.env.PROFILES_ROOT;
const bundleRoot = process.env.BUNDLE_ROOT;

if (!profilesRoot && !bundleRoot) {
  console.error("BUNDLE_ROOT (one memory) or PROFILES_ROOT (one memory per profile) is required");
  process.exit(1);
}

/** Autocommit must be able to work before a memory serves requests (issue #21). */
async function requireGitReady(kb: KnowledgeBase, label: string): Promise<void> {
  const gitReady = await kb.ensureGitReady();
  if (!gitReady.ok) {
    throw new Error(`GIT_AUTOCOMMIT=true but autocommit cannot work for ${label}: ${gitReady.reason}`);
  }
}

let host: MemoryHost;
let admin: ReturnType<typeof adminRouter> | undefined;
let serving: string;

try {
  if (profilesRoot) {
    const registry = new ProfileRegistry(profilesRoot, { gitAutocommit });
    const existing = await registry.memories();
    if (gitAutocommit) {
      for (const { name, kb } of existing) await requireGitReady(kb, `profile "${name}"`);
    }
    host = profileMemoryHost(registry);
    serving = `${existing.length} profile(s) from ${registry.root}`;
    console.log("[understory] auth: a profile API key is required for /mcp and /api");
    if (process.env.AUTH_TOKEN) {
      console.error("[understory] AUTH_TOKEN is ignored in profile mode — each profile has its own key");
    }

    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      admin = adminRouter(registry, adminToken, async (name) => {
        if (!gitAutocommit) return;
        const created = (await registry.memories()).find((m) => m.name === name);
        if (created) await requireGitReady(created.kb, `profile "${name}"`);
      });
      console.log("[understory] admin: profile management enabled at /admin (ADMIN_TOKEN)");
    } else {
      console.log("[understory] admin: /admin disabled (set ADMIN_TOKEN, or manage profiles with the CLI)");
    }
  } else {
    const kb = new KnowledgeBase(bundleRoot!, { gitAutocommit });
    if (gitAutocommit) await requireGitReady(kb, "the bundle");
    const authToken = process.env.AUTH_TOKEN;
    host = singleMemoryHost(kb, authToken);
    serving = `bundle ${bundleRoot}`;
    console.log(
      authToken
        ? "[understory] auth: bearer token required for /mcp and /api"
        : "[understory] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)"
    );
  }
} catch (err) {
  console.error(`[understory] ${(err as Error).message}`);
  process.exit(1);
}

if (gitAutocommit) console.log("[understory] git autocommit: enabled (bundle history is being recorded)");

startDreamer(async () => (await host.memories()).map(({ kb, profile }) => ({ kb, label: profile })));

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

const llmTimeout = resolveLlmTimeout();
if (llmTimeout.warning) console.error(`[understory] ${llmTimeout.warning}`);
console.log(`[understory] llm timeout: ${process.env.LLM_TIMEOUT && llmTimeout.ms != null ? process.env.LLM_TIMEOUT.trim() : "none"}`);

const maxSteps = resolveMaxSteps();
if (maxSteps.warning) console.error(`[understory] ${maxSteps.warning}`);
console.log(`[understory] agent max steps: ${maxSteps.steps}`);

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const app = buildApp(host, { webDist, admin });

const port = Number(process.env.PORT ?? 3800);
app.listen(port, "0.0.0.0", () => {
  console.log(`understory serving ${serving} on :${port} (web + /api + /mcp)`);
});
