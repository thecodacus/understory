import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KnowledgeBase, runMutation, runQueryCached, type MutationOutcome } from "@understory/core";
import { buildSeedMemory, seedInstructions } from "./seed.js";

/**
 * Build the OKF MCP server. Each knowledge tool internally drives the LLM
 * agent (OKF spec in its system prompt) against the bundle.
 * Transport-agnostic — used by both the stdio bin and the HTTP endpoint.
 *
 * Seed memory: a session-start overview of what the KB contains, injected via
 * BOTH channels that reach the client LLM — the initialize `instructions`
 * field (standards channel) and the memory_query tool description (universal
 * fallback; every tool-calling client loads descriptions). Without it the
 * client model has no signal that memory might hold an answer.
 */
export async function buildMcpServer(kb: KnowledgeBase): Promise<McpServer> {
  // Seed generation must never prevent the server from starting — a missing
  // or empty bundle root degrades to a minimal seed, not a crash.
  const seed = await buildSeedMemory(kb).catch((err: Error) => {
    console.error(`[understory] seed generation failed: ${err.message}`);
    return "(memory overview unavailable — the bundle may be empty or unreadable; memory_status can diagnose)";
  });

  const queryDescription = (s: string) =>
    `Ask a natural-language question. An internal agent searches the OKF knowledge base, ` +
    `reads relevant concepts, and answers with cited bundle paths.\n\n` +
    `CURRENT MEMORY OVERVIEW:\n${s}`;

  const server = new McpServer(
    { name: "understory", version: "0.1.0" },
    { instructions: seedInstructions(seed) }
  );

  const queryTool = server.registerTool(
    "memory_query",
    {
      title: "Query the knowledge base",
      description: queryDescription(seed),
      inputSchema: { question: z.string().describe("The question to answer") },
    },
    async ({ question }) => {
      const { answer, source } = await runQueryCached(kb, question);
      const marker = source === "cache" ? "\n\n(cached answer)" : source === "hot" ? "\n\n(hot memory)" : "";
      return {
        content: [{ type: "text", text: `${answer}${marker}` }],
      };
    }
  );

  /**
   * Re-derive the seed after a mutation and push it into memory_query's
   * description; RegisteredTool.update() emits tools/list_changed so
   * long-lived (stdio) sessions see the fresh overview. Best-effort — a
   * refresh failure must never fail the mutation that triggered it.
   * (Instructions can't be updated mid-session; they refresh per session.)
   */
  const refreshSeed = async () => {
    try {
      const fresh = await buildSeedMemory(kb);
      queryTool.update({ description: queryDescription(fresh) });
    } catch (err) {
      console.error(`[understory] seed refresh failed: ${(err as Error).message}`);
    }
  };

  const mutationOutcomeResponse = (outcome: MutationOutcome) => {
    if (outcome.ok) {
      const { summary, filesChanged } = outcome.result;
      return {
        content: [
          {
            type: "text" as const,
            text: `${summary}\n\nFiles changed:\n${filesChanged.map((f) => `- ${f}`).join("\n") || "- none"}`,
          },
        ],
      };
    }
    if (outcome.status === "partial") {
      return {
        content: [
          {
            type: "text" as const,
            text: `⚠ Partial mutation: ${outcome.filesChanged.length} file(s) written before failure.\nFiles: ${outcome.filesChanged.join(", ")}\nError: ${outcome.error}`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Mutation failed: ${outcome.error}` }],
      isError: true,
    };
  };

  server.registerTool(
    "memory_add",
    {
      title: "Add knowledge",
      description:
        "Provide free-form knowledge (facts, docs, decisions, runbooks). An internal agent searches for overlap, then creates or extends OKF concepts; indexes and the update log are maintained automatically.",
      inputSchema: {
        content: z.string().describe("The knowledge to record, in any prose form"),
        suggested_path: z
          .string()
          .optional()
          .describe('Optional bundle path hint, e.g. "/apis/payments.md"'),
      },
    },
    async ({ content, suggested_path }) => {
      // Wrap the payload as an explicit directive. Bare content (e.g. a plain
      // fact like "The user's name is Anirban Kar.") otherwise reads as a chat
      // message and the agent replies conversationally instead of persisting it.
      const instruction =
        `Persist the following knowledge into the knowledge base. First search for ` +
        `related or owning concepts. If this is an attribute or detail of an ` +
        `existing concept, patch it into that concept rather than creating a new ` +
        `one. Only a distinct stand-alone entity or substantial topic gets its own ` +
        `concept — and then you must also patch the related existing concepts to ` +
        `link back to it. This is content to store, not a message to answer — you ` +
        `must use the write tools.\n\n` +
        `KNOWLEDGE TO RECORD:\n${content}` +
        (suggested_path ? `\n\nIf it fits, place new content at ${suggested_path}.` : "");
      const outcome = await runMutation(kb, instruction);
      await refreshSeed();
      return mutationOutcomeResponse(outcome);
    }
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update knowledge",
      description:
        "Instruct a change to existing knowledge (correct a fact, deprecate a concept, restructure). An internal agent locates the concepts and applies targeted edits.",
      inputSchema: {
        instruction: z.string().describe("What to change, in natural language"),
      },
    },
    async ({ instruction }) => {
      const outcome = await runMutation(kb, instruction);
      await refreshSeed();
      return mutationOutcomeResponse(outcome);
    }
  );

  server.registerTool(
    "memory_status",
    {
      title: "Knowledge base status",
      description:
        "Deterministic (no LLM): bundle statistics and OKF conformance report.",
      inputSchema: {},
    },
    async () => {
      const [report, lint, types] = await Promise.all([kb.validate(), kb.lint(), kb.listTypes()]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                conformant: report.conformant,
                concepts: report.conceptCount,
                directories: report.directoryCount,
                types,
                errors: report.issues.filter((i) => i.severity === "error"),
                warnings: report.issues.filter((i) => i.severity === "warning").length,
                graph: {
                  links: lint.linkCount,
                  orphans: lint.orphans.length,
                  brokenLinks: lint.brokenLinks.length,
                  healthy: lint.healthy,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "memory_maintain",
    {
      title: "Maintain / repair memory",
      description:
        "Health-check and repair the knowledge graph: an internal agent wires orphaned concepts (nothing links to them) into related concepts and fixes broken links. Run periodically to counter drift. No-op when the graph is already healthy.",
      inputSchema: {},
    },
    async () => {
      const before = await kb.lint();
      if (before.healthy) {
        return {
          content: [
            {
              type: "text",
              text: `Memory is healthy — ${before.conceptCount} concepts, ${before.linkCount} links, no orphans, no broken links. Nothing to repair.`,
            },
          ],
        };
      }

      const orphanList =
        before.orphans.map((o) => `- ${o.path}${o.title ? ` (${o.title})` : ""}`).join("\n") ||
        "(none)";
      const brokenList =
        before.brokenLinks.map((b) => `- ${b.path} → ${b.target} (missing)`).join("\n") ||
        "(none)";
      const instruction =
        `Repair the knowledge graph. This is a maintenance task — use the write tools.\n\n` +
        `ORPHANED CONCEPTS (no other concept links to them). For each, read it and the ` +
        `concepts it relates to, then wire it in: patch a genuinely related concept to ` +
        `reference it, and/or add outbound links from it to related concepts. Do NOT ` +
        `invent relationships that don't exist — if an orphan genuinely relates to ` +
        `nothing, leave it.\n${orphanList}\n\n` +
        `BROKEN LINKS (target does not exist). Fix the path if the target was renamed/moved, ` +
        `or remove the link if the target is gone.\n${brokenList}\n\n` +
        `Follow the enrich / link-both-ways rules. Read concepts before editing.`;

      const outcome = await runMutation(kb, instruction);
      await refreshSeed();
      if (!outcome.ok) return mutationOutcomeResponse(outcome);
      const { summary, filesChanged } = outcome.result;
      const after = await kb.lint();
      return {
        content: [
          {
            type: "text",
            text:
              `${summary}\n\n` +
              `Graph health: orphans ${before.orphans.length} → ${after.orphans.length}, ` +
              `broken links ${before.brokenLinks.length} → ${after.brokenLinks.length}.\n` +
              `Files changed:\n${filesChanged.map((f) => `- ${f}`).join("\n") || "- none"}`,
          },
        ],
      };
    }
  );

  return server;
}
