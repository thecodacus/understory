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

import { modelAbortSignal, resolveLlmTimeout, resolveMaxSteps, runMutation, runQuery } from "../src/agent/agent.js";
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
  delete process.env.AGENT_MAX_STEPS;
});

/** The single trace the run saved under the bundle. */
async function savedTrace(): Promise<{ outcome: string; notation: string; answer: string }> {
  const dir = path.join(root, ".traces");
  const [file] = await fs.readdir(dir);
  return JSON.parse(await fs.readFile(path.join(dir, file), "utf-8"));
}

/** What generateText resolves to when the model is still calling tools on its last allowed step. */
function cutOffAfter(steps: number) {
  return { text: "", steps: Array.from({ length: steps }, () => ({})), finishReason: "tool-calls" };
}

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

describe("resolveMaxSteps", () => {
  it("defaults to 12 steps", () => {
    expect(resolveMaxSteps({})).toEqual({ steps: 12 });
    expect(resolveMaxSteps({ AGENT_MAX_STEPS: " " })).toEqual({ steps: 12 });
  });

  it("reads a positive whole number from AGENT_MAX_STEPS", () => {
    expect(resolveMaxSteps({ AGENT_MAX_STEPS: "40" })).toEqual({ steps: 40 });
  });

  it("warns and keeps the default for anything else", () => {
    for (const raw of ["0", "-3", "2.5", "many"]) {
      const resolved = resolveMaxSteps({ AGENT_MAX_STEPS: raw });
      expect(resolved.steps).toBe(12);
      expect(resolved.warning).toContain(raw);
    }
  });
});

describe("step limit (#37)", () => {
  it("fails a mutation that used every step and wrote nothing", async () => {
    generateText.mockResolvedValue(cutOffAfter(12));
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Consolidate the memory");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe("failed");
      expect(outcome.error).toContain("all 12 steps");
      expect(outcome.error).toContain("AGENT_MAX_STEPS");
    }
    const trace = await savedTrace();
    expect(trace.outcome).toBe("step-limit");
    expect(trace.notation).toContain("step limit");
  });

  it("reports the files a cut-off mutation did write as partial", async () => {
    generateText.mockImplementation(async ({ tools }) => {
      await tools.write_concept.execute(
        { path: "/facts/a.md", frontmatter: { type: "Fact", title: "A" }, body: "alpha", log_summary: "Added A." },
        { toolCallId: "c1", messages: [] }
      );
      return cutOffAfter(12);
    });
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Record A and link it");

    expect(outcome).toMatchObject({ ok: false, status: "partial", filesChanged: ["/facts/a.md"] });
    expect((await savedTrace()).outcome).toBe("step-limit");
  });

  it("uses the budget from AGENT_MAX_STEPS", async () => {
    process.env.AGENT_MAX_STEPS = "3";
    generateText.mockResolvedValue(cutOffAfter(3));
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Consolidate the memory");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("all 3 steps");
  });

  it("keeps a run that finished on its last allowed step a success", async () => {
    generateText.mockResolvedValue({
      text: "Nothing to change.",
      steps: Array.from({ length: 12 }, () => ({})),
      finishReason: "stop",
    });
    const kb = new KnowledgeBase(root);

    const outcome = await runMutation(kb, "Consolidate the memory");

    expect(outcome.ok).toBe(true);
    expect((await savedTrace()).outcome).toBe("success");
  });

  it("marks a query that ran out of steps and says so in the answer", async () => {
    generateText.mockResolvedValue(cutOffAfter(12));
    const kb = new KnowledgeBase(root);

    const result = await runQuery(kb, "What do we know about deploys?");

    expect(result.stepLimited).toBe(true);
    expect(result.answer).toContain("all 12 steps");
    expect((await savedTrace()).outcome).toBe("step-limit");
  });
});
