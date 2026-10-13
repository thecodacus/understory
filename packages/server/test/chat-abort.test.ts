import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "@understory/core";
import { buildApp } from "../src/app.js";
import { singleMemoryHost } from "../src/host.js";

let root: string;
let llm: http.Server;
let app: http.Server;
let llmRequested: Promise<void>;
let llmClosed: Promise<void>;

const port = (server: http.Server) => (server.address() as AddressInfo).port;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-chat-"));
  // A model endpoint that accepts the request and never answers.
  let requested: () => void;
  let closed: () => void;
  llmRequested = new Promise((resolve) => (requested = resolve));
  llmClosed = new Promise((resolve) => (closed = resolve));
  llm = http.createServer((req) => {
    req.resume();
    requested();
    req.socket.on("close", () => closed());
  });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  process.env.LLM_API_BASE_URL = `http://127.0.0.1:${port(llm)}`;
  process.env.LLM_MODEL = "m";

  app = buildApp(singleMemoryHost(new KnowledgeBase(root), undefined)).listen(0);
});

afterEach(async () => {
  app.closeAllConnections();
  llm.closeAllConnections();
  await Promise.all([new Promise((r) => app.close(r)), new Promise((r) => llm.close(r))]);
  delete process.env.LLM_API_BASE_URL;
  delete process.env.LLM_MODEL;
  await fs.rm(root, { recursive: true, force: true });
});

describe("POST /api/chat (#42)", () => {
  it("stops the model call when the browser stops listening", async () => {
    const client = new AbortController();
    const response = fetch(`http://127.0.0.1:${port(app)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "what do we know?" }] }],
      }),
      signal: client.signal,
    }).catch(() => undefined);

    await llmRequested;
    client.abort();
    await response;

    // Resolves only if understory drops its request to the model; the test times out otherwise.
    await llmClosed;
    expect(true).toBe(true);
  });
});
