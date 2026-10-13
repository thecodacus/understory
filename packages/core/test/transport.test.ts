import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generateText } from "ai";
import { createModel } from "../src/providers/index.js";

let server: http.Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function endpoint(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("LLM transport (#32)", () => {
  it("sends model requests through the dedicated dispatcher and reads the reply", async () => {
    let authorization: string | undefined;
    const baseURL = await endpoint((req, res) => {
      authorization = req.headers.authorization;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "c",
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    const model = await createModel({ baseURL, apiKey: "secret", format: "openai", model: "m" });

    const result = await generateText({ model, prompt: "ping", maxRetries: 0 });

    expect(result.text).toBe("pong");
    expect(authorization).toBe("Bearer secret");
  });

  it("still cancels an in-flight request when the caller aborts", async () => {
    let closed: () => void;
    const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
    const baseURL = await endpoint((req) => {
      req.resume();
      req.socket.on("close", () => closed());
      // Never answers.
    });
    const model = await createModel({ baseURL, apiKey: "none", format: "openai", model: "m" });
    const abort = new AbortController();

    const run = generateText({ model, prompt: "ping", maxRetries: 0, abortSignal: abort.signal });
    setTimeout(() => abort.abort(), 50);

    await expect(run).rejects.toThrow();
    await upstreamClosed;
  });
});
