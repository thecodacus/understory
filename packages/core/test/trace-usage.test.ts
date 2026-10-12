import { describe, it, expect } from "vitest";
import { TraceRecorder } from "../src/agent/trace.js";

describe("trace usage (#15)", () => {
  it("records token usage on the finalized trace", () => {
    const r = new TraceRecorder();
    r.record("read_concept", "/a.md", ["/a.md"]);
    const trace = r.finalize("query", "q", "a", "success", ["openai:m"], {
      inputTokens: 3200,
      outputTokens: 410,
    });
    expect(trace.usage).toEqual({ inputTokens: 3200, outputTokens: 410 });
  });

  it("leaves usage undefined when the provider reports none", () => {
    const r = new TraceRecorder();
    const trace = r.finalize("query", "q", "a");
    expect(trace.usage).toBeUndefined();
  });
});
