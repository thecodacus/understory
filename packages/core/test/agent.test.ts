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

import { modelAbortSignal, runMutation } from "../src/agent/agent.js";
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

describe("modelAbortSignal", () => {
  it("aborts when the configured model deadline expires", async () => {
    const signal = modelAbortSignal({}, { UNDERSTORY_LLM_TIMEOUT_MS: "10" });

    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(signal.aborted).toBe(true);
  });

  it("propagates caller cancellation before the deadline", () => {
    const caller = new AbortController();
    const signal = modelAbortSignal({ abortSignal: caller.signal, timeoutMs: 60_000 });

    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("runMutation", () => {
  it("fails when the model returns without changing a file", async () => {
    generateText.mockResolvedValue({ text: "Done", steps: [] });
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Record a fact");

    expect(outcome).toEqual({
      ok: false,
      status: "failed",
      error: "Mutation completed without changing any files. Model response: Done",
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
  });
});
