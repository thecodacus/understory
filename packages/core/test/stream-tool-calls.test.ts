import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createModel } from "../src/providers/index.js";

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

/** An OpenAI-compatible endpoint that streams the given chunks for its first call, then a plain answer. */
async function streamingEndpoint(firstCall: unknown[]): Promise<string> {
  let calls = 0;
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const chunks =
        calls++ === 0
          ? firstCall
          : [{ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] }];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify({ id: "c", model: "m", ...(chunk as object) })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("streamed tool calls (#43)", () => {
  // Google's OpenAI-compatible endpoint sends the tool call in one chunk and
  // leaves out the `index` that OpenAI puts on every tool-call delta.
  it("runs a tool call whose delta carries no index", async () => {
    const baseURL = await streamingEndpoint([
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                { id: "call-1", type: "function", function: { name: "lookup", arguments: '{"query":"deploy day"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    const model = await createModel({ baseURL, apiKey: "none", format: "openai", model: "m" });
    const queries: string[] = [];

    const result = streamText({
      model,
      prompt: "When do we deploy?",
      tools: {
        lookup: tool({
          description: "Look something up",
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => {
            queries.push(query);
            return "Fridays";
          },
        }),
      },
      stopWhen: stepCountIs(3),
      onError: () => {},
    });

    expect(await result.text).toBe("done");
    expect(queries).toEqual(["deploy day"]);
  });
});
