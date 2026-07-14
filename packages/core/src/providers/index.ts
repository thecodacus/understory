import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export type ProviderName = "anthropic" | "openrouter" | "llamacpp" | "local";

const PROVIDER_NAMES: ProviderName[] = ["anthropic", "openrouter", "llamacpp", "local"];

export interface ProviderConfig {
  /** Default provider, from LLM_PROVIDER env. */
  provider: ProviderName;
  /** Default model id for that provider, from LLM_MODEL env. */
  model: string;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-5",
  openrouter: "anthropic/claude-sonnet-5",
  llamacpp: "", // auto-discovered from /v1/models
  local: "local-model",
};

export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const provider = (env.LLM_PROVIDER ?? "anthropic") as ProviderName;
  if (!PROVIDER_NAMES.includes(provider)) {
    throw new Error(
      `Unknown LLM_PROVIDER "${env.LLM_PROVIDER}" (${PROVIDER_NAMES.join("|")})`
    );
  }
  return { provider, model: env.LLM_MODEL ?? DEFAULT_MODELS[provider] };
}

/** Providers the current env has credentials/config for (drives the UI picker). */
export function availableProviders(env: NodeJS.ProcessEnv = process.env): ProviderName[] {
  const out: ProviderName[] = [];
  if (env.ANTHROPIC_API_KEY) out.push("anthropic");
  if (env.OPENROUTER_API_KEY) out.push("openrouter");
  if (env.LLAMACPP_BASE_URL) out.push("llamacpp");
  if (env.LOCAL_BASE_URL) out.push("local");
  return out;
}

/** Ensure the URL ends in /v1 — llama-server serves the OpenAI API there. */
function normalizeV1(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// llama-server (or llama-swap in front of it) exposes GET /v1/models.
// Cache discovery per base URL for a short TTL — avoids a discovery
// round-trip on every single agent turn, while still noticing within a
// session that the user swapped which model llama-swap has loaded (a
// process-lifetime cache would never see that again without a restart).
const DISCOVERY_TTL_MS = 60_000;
const discoveryCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();

/**
 * Pick a model id from llama-server's /v1/models. Prefers a model llama-swap
 * reports as "loaded" (avoids a multi-minute model swap); falls back to the
 * first listed. Plain llama-server lists exactly one model, no status field.
 */
export async function discoverLlamaCppModel(baseURL: string): Promise<string> {
  const url = normalizeV1(baseURL);
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  const promise = (async () => {
    const res = await fetch(`${url}/models`);
    if (!res.ok) {
      throw new Error(`llama-server model discovery failed: ${res.status} at ${url}/models`);
    }
    const body = (await res.json()) as {
      data?: { id: string; status?: { value?: string } }[];
    };
    const models = body.data ?? [];
    if (models.length === 0) {
      throw new Error(`llama-server at ${url} lists no models`);
    }
    const loaded = models.find((m) => m.status?.value === "loaded");
    return (loaded ?? models[0]).id;
  })();
  discoveryCache.set(url, { promise, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  // Don't cache failures — the server may just be starting up.
  promise.catch(() => discoveryCache.delete(url));
  return promise;
}

export async function resolveModel(
  provider?: ProviderName,
  model?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LanguageModel> {
  const config = loadProviderConfig(env);
  const p = provider ?? config.provider;
  let m = model ?? (provider && provider !== config.provider ? DEFAULT_MODELS[p] : config.model);

  switch (p) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return anthropic(m);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      return openrouter.chat(m);
    }
    case "llamacpp": {
      const baseURL = env.LLAMACPP_BASE_URL;
      if (!baseURL) throw new Error("LLAMACPP_BASE_URL is required for the llamacpp provider");
      if (!m) m = await discoverLlamaCppModel(baseURL);
      const llamacpp = createOpenAICompatible({
        name: "llamacpp",
        baseURL: normalizeV1(baseURL),
        // llama-server ignores auth unless started with --api-key.
        apiKey: env.LLAMACPP_API_KEY ?? "not-needed",
      });
      return llamacpp(m);
    }
    case "local": {
      const local = createOpenAICompatible({
        name: "local",
        baseURL: env.LOCAL_BASE_URL ?? "http://localhost:8080/v1",
        apiKey: env.LOCAL_API_KEY ?? "not-needed",
      });
      return local(m);
    }
  }
}
