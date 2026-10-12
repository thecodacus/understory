import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const { generateText } = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText,
    streamText: vi.fn(),
    stepCountIs: vi.fn(() => vi.fn()),
  };
});

vi.mock("../src/providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/index.js")>();
  return {
    ...actual,
    createModel: vi.fn(async () => ({ modelId: "test-model" })),
  };
});

import { modelAbortSignal, resolveLlmTimeout, runMutation } from "../src/agent/agent.js";
import { KnowledgeBase } from "../src/okf/index.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-agent-"));
  generateText.mockReset();
  process.env.LLM_API_BASE_URL = "http://localhost:1234/v1";
  process.env.LLM_API_KEY = "test";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "test-model";
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.LLM_API_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_API_FORMAT;
  delete process.env.LLM_MODEL;
});

describe("resolveLlmTimeout", () => {
  it("applies no deadline unless LLM_TIMEOUT is set", () => {
    expect(resolveLlmTimeout({})).toEqual({ ms: null });
    expect(resolveLlmTimeout({ LLM_TIMEOUT: "" })).toEqual({ ms: null });
  });

  it("parses duration strings", () => {
    expect(resolveLlmTimeout({ LLM_TIMEOUT: "10m" })).toEqual({ ms: 600_000 });
    expect(resolveLlmTimeout({ LLM_TIMEOUT: "2h" })).toEqual({ ms: 7_200_000 });
  });

  it("warns and applies no deadline for unparseable or non-positive values", () => {
    for (const raw of ["soon", "120000", "0s", "NaN"]) {
      const resolved = resolveLlmTimeout({ LLM_TIMEOUT: raw });
      expect(resolved.ms).toBeNull();
      expect(resolved.warning).toContain(raw);
    }
  });
});

describe("modelAbortSignal", () => {
  it("returns no signal when there is neither a caller signal nor a deadline", () => {
    expect(modelAbortSignal({}, {})).toBeUndefined();
  });

  it("aborts when the configured model deadline expires", async () => {
    const signal = modelAbortSignal({}, { LLM_TIMEOUT: "10ms" })!;

    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(signal.aborted).toBe(true);
  });

  it("propagates caller cancellation with no deadline configured", () => {
    const caller = new AbortController();
    const signal = modelAbortSignal({ abortSignal: caller.signal }, {})!;

    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("propagates caller cancellation before the deadline", () => {
    const caller = new AbortController();
    const signal = modelAbortSignal({ abortSignal: caller.signal, timeoutMs: 60_000 })!;

    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("runMutation", () => {
  it("fails when the model returns an empty response without changing a file", async () => {
    generateText.mockResolvedValue({ text: "  ", steps: [] });
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Record a fact", { abortSignal: new AbortController().signal });

    expect(outcome).toEqual({
      ok: false,
      status: "failed",
      error: "Mutation returned an empty response without changing any files.",
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
  });

  it("succeeds when the model explains why nothing needed writing", async () => {
    generateText.mockResolvedValue({ text: "Already recorded in /facts/a.md; nothing to change.", steps: [] });
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Record a fact");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.filesChanged).toEqual([]);
      expect(outcome.result.summary).toContain("Already recorded");
    }
  });
});
