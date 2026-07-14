import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { discoverLlamaCppModel, resolveFallbackConfig, resolveModelConfig } from "../src/providers/index.js";
import { isRetryableError, withFallback } from "../src/providers/fallback.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

// Each test uses its own base URL — discovery is cached per URL, and the
// cache is module-level state shared across tests in this file.
let counter = 0;
function freshBaseURL() {
  return `http://localhost:${8080 + counter++}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Model discovery (PR #4: 60s TTL on discovery cache) ──────────

describe("discoverLlamaCppModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prefers the model llama-swap reports as loaded", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "model-a", status: { value: "unloaded" } },
          { id: "model-b", status: { value: "loaded" } },
        ],
      })
    );
    await expect(discoverLlamaCppModel(freshBaseURL())).resolves.toBe("model-b");
  });

  it("does not re-fetch within the TTL window", async () => {
    const url = freshBaseURL();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data: [{ id: "model-a" }] }));
    await discoverLlamaCppModel(url);
    await discoverLlamaCppModel(url);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-checks the loaded model again after the TTL expires", async () => {
    const url = freshBaseURL();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-b" }] }));

    await expect(discoverLlamaCppModel(url)).resolves.toBe("model-a");
    vi.advanceTimersByTime(61_000);
    await expect(discoverLlamaCppModel(url)).resolves.toBe("model-b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed discovery", async () => {
    const url = freshBaseURL();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }));

    await expect(discoverLlamaCppModel(url)).rejects.toThrow();
    await expect(discoverLlamaCppModel(url)).resolves.toBe("model-a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ── Generic provider config (PR #5) ────────────────────────────────

describe("generic provider config", () => {
  it("reads the primary and fallback slots from generic env vars", () => {
    expect(
      resolveModelConfig(
        env({
          LLM_API_BASE_URL: "https://api.deepseek.com/v1",
          LLM_API_KEY: "sk-test",
          LLM_API_FORMAT: "openai",
          LLM_MODEL: "deepseek-chat",
        })
      )
    ).toEqual({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      format: "openai",
      model: "deepseek-chat",
    });

    expect(
      resolveFallbackConfig(
        env({
          LLM_FALLBACK_API_BASE_URL: "http://localhost:8080/v1",
          LLM_FALLBACK_API_FORMAT: "openai",
        })
      )
    ).toEqual({
      baseURL: "http://localhost:8080/v1",
      apiKey: "not-needed",
      format: "openai",
      model: "",
    });
  });

  it("maps legacy providers to the generic model config", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveModelConfig(env({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a" }))).toMatchObject({
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "a",
      format: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(resolveModelConfig(env({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o" }))).toMatchObject({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "o",
      format: "openai",
      model: "anthropic/claude-sonnet-5",
    });
    expect(resolveModelConfig(env({ LLM_PROVIDER: "llamacpp", LLAMACPP_BASE_URL: "http://localhost:8080" }))).toMatchObject({
      baseURL: "http://localhost:8080",
      apiKey: "not-needed",
      format: "openai",
      model: "",
    });
    expect(resolveModelConfig(env({ LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "d" }))).toMatchObject({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "d",
      format: "openai",
      model: "deepseek-chat",
    });
    expect(resolveModelConfig(env({ LLM_PROVIDER: "local", LOCAL_BASE_URL: "http://local/v1" }))).toMatchObject({
      baseURL: "http://local/v1",
      apiKey: "not-needed",
      format: "openai",
      model: "local-model",
    });
  });

  it("keeps the historical anthropic default but fails closed on ambiguous legacy env", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveModelConfig(env({ ANTHROPIC_API_KEY: "a" }))).toMatchObject({
      format: "anthropic",
      apiKey: "a",
    });
    expect(() =>
      resolveModelConfig(env({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" }))
    ).toThrow(/Ambiguous legacy LLM configuration/);
  });
});

// ── Fallback middleware (PR #5) ─────────────────────────────────────

describe("fallback middleware", () => {
  it("uses the fallback for retryable doGenerate and doStream setup failures", async () => {
    const primary = fakeModel({
      doGenerate: vi.fn(async () => {
        throw { statusCode: 500 };
      }),
      doStream: vi.fn(async () => {
        throw Object.assign(new TypeError("network"), { code: "ECONNRESET" });
      }),
    });
    const fallback = fakeModel({
      doGenerate: vi.fn(async () => ({ content: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] })),
      doStream: vi.fn(async () => ({ stream: new ReadableStream() })),
    });

    const model = withFallback(primary, fallback);
    await expect(model.doGenerate({} as never)).resolves.toMatchObject({ finishReason: "stop" });
    await expect(model.doStream({} as never)).resolves.toHaveProperty("stream");
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doStream).toHaveBeenCalledTimes(1);
  });

  it("does not fallback for non-retryable errors", async () => {
    const primary = fakeModel({
      doGenerate: vi.fn(async () => {
        throw { statusCode: 401 };
      }),
    });
    const fallback = fakeModel({ doGenerate: vi.fn() });

    await expect(withFallback(primary, fallback).doGenerate({} as never)).rejects.toMatchObject({ statusCode: 401 });
    expect(fallback.doGenerate).not.toHaveBeenCalled();
  });
});

// ── isRetryableError (PR #5) ────────────────────────────────────────

describe("isRetryableError", () => {
  it("uses a conservative positive allowlist", () => {
    const prev = process.env.LLM_FALLBACK_RETRY_429;
    process.env.LLM_FALLBACK_RETRY_429 = "false";
    try {
      expect(isRetryableError({ statusCode: 408 })).toBe(true);
      expect(isRetryableError({ statusCode: 500 })).toBe(true);
      expect(isRetryableError({ statusCode: 502 })).toBe(true);
      expect(isRetryableError({ statusCode: 503 })).toBe(true);
      expect(isRetryableError({ statusCode: 504 })).toBe(true);
      expect(isRetryableError({ statusCode: 401 })).toBe(false);
      expect(isRetryableError({ statusCode: 403 })).toBe(false);
      expect(isRetryableError({ statusCode: 429 })).toBe(false);
      expect(isRetryableError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error("abort"), { name: "AbortError" }))).toBe(false);
      expect(isRetryableError(new Error("ordinary"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLM_FALLBACK_RETRY_429;
      else process.env.LLM_FALLBACK_RETRY_429 = prev;
    }
  });

  it("respects LLM_FALLBACK_RETRY_429", () => {
    const prev = process.env.LLM_FALLBACK_RETRY_429;
    try {
      process.env.LLM_FALLBACK_RETRY_429 = "true";
      expect(isRetryableError({ statusCode: 429 })).toBe(true);
      process.env.LLM_FALLBACK_RETRY_429 = "false";
      expect(isRetryableError({ statusCode: 429 })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLM_FALLBACK_RETRY_429;
      else process.env.LLM_FALLBACK_RETRY_429 = prev;
    }
  });

  it("recognizes AI SDK RetryError and nested undici transport errors", () => {
    // AI SDK RetryError shape after exhausting internal retries
    expect(isRetryableError({ isRetryable: true, message: "Failed after 3 attempts" })).toBe(true);
    // undici error nested inside cause
    expect(isRetryableError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })).toBe(true);
    // deep nesting
    expect(isRetryableError({ cause: { cause: { code: "ECONNRESET" } } })).toBe(true);
    // isRetryable: false should NOT trigger
    expect(isRetryableError({ isRetryable: false, message: "some error" })).toBe(false);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function fakeModel(overrides: Record<string, unknown> = {}) {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => ({ content: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] }),
    doStream: async () => ({ stream: new ReadableStream() }),
    ...overrides,
  } as any;
}
