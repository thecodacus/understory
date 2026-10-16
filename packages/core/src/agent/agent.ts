import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import type { KnowledgeBase } from "../okf/index.js";
import {
  createModel,
  resolveFallbackConfig,
  resolveModelConfig,
  type ModelConfig,
} from "../providers/index.js";
import { withFallback } from "../providers/fallback.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildReadTools, buildWriteTools, formatTreeCompact } from "./tools.js";
import { TraceRecorder, TraceStore, type TraceUsage } from "./trace.js";
import { parseDuration } from "../util/duration.js";

const DEFAULT_MAX_STEPS = 12;

export interface AgentOptions {
  model?: string;
  /** Cancel the model run when the caller disconnects or explicitly aborts. */
  abortSignal?: AbortSignal;
  /** Total deadline for the model run. Defaults to LLM_TIMEOUT; no deadline when neither is set. */
  timeoutMs?: number;
}

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
  /**
   * True when the run used its whole step budget. `answer` is not necessarily an
   * apology: the final step is tool-free, so a budget-exhausted run answers from
   * what it already retrieved and the answer may be a usable partial one (recorded
   * as the "step-limit-partial" trace outcome). Only when it produced nothing does
   * `answer` say so.
   */
  stepLimited?: boolean;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
}

export type MutationOutcome =
  | { ok: true; result: MutationResult }
  | { ok: false; status: "partial"; filesChanged: string[]; error: string; traceId: string }
  | { ok: false; status: "failed"; error: string };

interface ResolvedAgentModel {
  model: LanguageModel;
  modelChain: string[];
}

async function promptContext(kb: KnowledgeBase, mode: "query" | "mutate" | "chat") {
  const [types, tree] = await Promise.all([kb.listTypes(), kb.listTree()]);
  // Prompt context is re-sent at every step of a run, so the filing map is paid
  // for once per step rather than once per run: on a 500-concept bundle the
  // indented tree is ~61,000 tokens and a ten-step run pays for it ten times.
  // A query files nothing, so it only needs to know which areas exist; a
  // mutation needs the nested map to choose where to file. list_directory still
  // returns full detail for anyone who asks for it.
  const treeSummary = mode === "query" ? formatTreeCompact(tree, 60, 1) : formatTreeCompact(tree);
  return { existingTypes: types, treeSummary, mode };
}

async function resolveAgentModel(
  options: AgentOptions,
  mode: "query" | "mutate" | "chat",
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedAgentModel> {
  const primaryConfig = withModelOverride(resolveModelConfig(env), options.model);
  const primary = await createModel(primaryConfig);
  const fallbackConfig = resolveFallbackConfig(env);

  if (!fallbackConfig) {
    return { model: primary, modelChain: [modelLabel(primaryConfig)] };
  }

  const allowFor = resolveAllowFor(env.LLM_FALLBACK_ALLOW_FOR);
  if (allowFor && !allowFor.has(mode)) {
    return { model: primary, modelChain: [modelLabel(primaryConfig)] };
  }

  const fallback = await createModel(fallbackConfig);
  return {
    model: withFallback(primary, fallback, {
      retry429: env.LLM_FALLBACK_RETRY_429 === "true",
    }),
    modelChain: [modelLabel(primaryConfig), modelLabel(fallbackConfig)],
  };
}

function resolveAllowFor(raw: string | undefined): Set<string> | null {
  if (!raw || raw === "*") return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function withModelOverride(config: ModelConfig, model: string | undefined): ModelConfig {
  return model ? { ...config, model } : config;
}

// No baseURL here by design: traces persist under <bundle>/.traces/, and a
// published bundle would otherwise leak internal hostnames/IPs/ports.
function modelLabel(config: ModelConfig): string {
  return `${config.format}:${config.model || "auto"}`;
}

function traceStore(kb: KnowledgeBase): TraceStore {
  return new TraceStore(kb.bundle.root);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The configured total deadline for one model run, from LLM_TIMEOUT
 * ("10m", "2h", ...). There is no deadline unless one is configured: healthy
 * runs on local hardware routinely take many minutes, so any default would
 * abort working setups. An unparseable value means no deadline plus a
 * warning, never a silent fallback.
 */
export function resolveLlmTimeout(env: NodeJS.ProcessEnv = process.env): {
  ms: number | null;
  warning?: string;
} {
  const raw = env.LLM_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return { ms: null };
  const ms = parseDuration(raw);
  if (ms === null || ms <= 0) {
    return {
      ms: null,
      warning: `LLM_TIMEOUT="${raw}" is not a positive duration (use e.g. 300s, 10m, 2h) — no deadline applied`,
    };
  }
  return { ms };
}

/**
 * How many model steps one agent run may take, from AGENT_MAX_STEPS. A step
 * is one model call plus the tool calls it asks for. An unusable value means
 * the default plus a warning, never a silent fallback.
 */
export function resolveMaxSteps(env: NodeJS.ProcessEnv = process.env): {
  steps: number;
  warning?: string;
} {
  const raw = env.AGENT_MAX_STEPS;
  if (raw === undefined || raw.trim() === "") return { steps: DEFAULT_MAX_STEPS };
  const steps = Number(raw);
  if (!Number.isInteger(steps) || steps < 1) {
    return {
      steps: DEFAULT_MAX_STEPS,
      warning: `AGENT_MAX_STEPS="${raw}" is not a positive whole number — using ${DEFAULT_MAX_STEPS}`,
    };
  }
  return { steps };
}

/**
 * A run that used every step and whose last step still asked for tools was
 * cut off by the budget. It did not finish, whatever it wrote on the way.
 */
function hitStepLimit(
  result: { steps: ReadonlyArray<unknown>; finishReason: string },
  maxSteps: number
): boolean {
  return result.steps.length >= maxSteps && result.finishReason === "tool-calls";
}

/**
 * Abort signal for a model run: fires when the caller cancels (always
 * honored) or when the configured deadline expires (opt-in). Undefined when
 * neither applies.
 */
export function modelAbortSignal(
  options: AgentOptions,
  env: NodeJS.ProcessEnv = process.env
): AbortSignal | undefined {
  const timeoutMs = options.timeoutMs ?? resolveLlmTimeout(env).ms;
  const signals: AbortSignal[] = [];
  if (options.abortSignal) signals.push(options.abortSignal);
  if (timeoutMs != null) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** Sum token usage across the run's steps (issue #15). Undefined when the provider reports none. */
function sumStepsUsage(
  steps: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number } }>
): TraceUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let reported = false;
  for (const step of steps) {
    const u = step.usage;
    if (!u || (u.inputTokens == null && u.outputTokens == null)) continue;
    reported = true;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  }
  return reported ? { inputTokens, outputTokens } : undefined;
}

/** Read-only Q&A over the bundle. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query");
  const recorder = new TraceRecorder();
  const maxSteps = resolveMaxSteps().steps;
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "query");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      abortSignal: modelAbortSignal(options),
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder),
      stopWhen: stepCountIs(maxSteps),
      // The final step is given no tools. A run that reaches its budget is then
      // forced to answer from what it has already retrieved, instead of stopping
      // mid-search while still asking for tools — which meant the whole run's
      // retrieval was discarded and replaced by an error string.
      prepareStep: ({ stepNumber }) => (stepNumber >= maxSteps - 1 ? { activeTools: [] } : {}),
    });
    if (hitStepLimit(result, maxSteps)) {
      // Fail soft: keep whatever the run actually wrote on the way. Half an
      // answer with its sources beats a full-priced run that returns nothing.
      const partial = result.text?.trim();
      const answer = partial
        ? `${partial}\n\n_(Partial answer: the run reached its ${maxSteps}-step budget and was forced to answer from what it had already retrieved. It may be incomplete.)_`
        : `The search used all ${maxSteps} steps without reaching an answer. Raise AGENT_MAX_STEPS to let it look further.`;
      const trace = recorder.finalize("query", question, answer, partial ? "step-limit-partial" : "step-limit", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return { answer, steps: result.steps.length, traceId: trace.id, stepLimited: true };
    }
    const trace = recorder.finalize("query", question, result.text, "success", modelChain, sumStepsUsage(result.steps));
    await traceStore(kb).save(trace);
    return { answer: result.text, steps: result.steps.length, traceId: trace.id };
  } catch (err) {
    const trace = recorder.finalize("query", question, errorMessage(err), "failed", modelChain);
    await traceStore(kb).save(trace);
    throw err;
  }
}

/** Knowledge add/update — full toolset, low temperature. */
export async function runMutation(
  kb: KnowledgeBase,
  instruction: string,
  options: AgentOptions = {}
): Promise<MutationOutcome> {
  const ctx = await promptContext(kb, "mutate");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  const maxSteps = resolveMaxSteps().steps;
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "mutate");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      abortSignal: modelAbortSignal(options),
      system: buildSystemPrompt(ctx),
      prompt: instruction,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.2,
    });
    if (hitStepLimit(result, maxSteps)) {
      const files = [...filesChanged].sort();
      const message =
        `The run used all ${maxSteps} steps and was stopped before it finished` +
        (files.length > 0 ? "; the files it changed may be incomplete" : " or changed any file") +
        `. Raise AGENT_MAX_STEPS to give it more room.`;
      const trace = recorder.finalize("mutation", instruction, message, "step-limit", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return files.length > 0
        ? { ok: false, status: "partial", filesChanged: files, error: message, traceId: trace.id }
        : { ok: false, status: "failed", error: message };
    }
    // A run that wrote nothing AND said nothing is a stalled/flaked model.
    // Writing nothing while explaining why (knowledge already present,
    // nothing genuinely related to link) is a legitimate outcome.
    if (filesChanged.size === 0 && result.text.trim() === "") {
      const message = "Mutation returned an empty response without changing any files.";
      const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return { ok: false, status: "failed", error: message };
    }
    const trace = recorder.finalize("mutation", instruction, result.text, "success", modelChain, sumStepsUsage(result.steps));
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary: result.text,
        filesChanged: [...filesChanged].sort(),
        steps: result.steps.length,
        traceId: trace.id,
      },
    };
  } catch (err) {
    const files = [...filesChanged].sort();
    const message = errorMessage(err);
    if (files.length > 0) {
      const summary = `Partial mutation: ${files.length} file(s) changed before failure. Error: ${message}`;
      const trace = recorder.finalize("mutation", instruction, summary, "partial", modelChain);
      await traceStore(kb).save(trace);
      return { ok: false, status: "partial", filesChanged: files, error: message, traceId: trace.id };
    }
    const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain);
    await traceStore(kb).save(trace);
    return { ok: false, status: "failed", error: message };
  }
}

/** Interactive chat — full toolset, streaming. Caller converts to a UI stream response. */
export async function streamChat(
  kb: KnowledgeBase,
  messages: ModelMessage[],
  options: AgentOptions = {}
) {
  const ctx = await promptContext(kb, "chat");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  const maxSteps = resolveMaxSteps().steps;
  let modelChain: string[] = [];
  // The user turn that started this run, for the trace record.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const input =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : lastUser?.content
          ?.map((part) => (part.type === "text" ? part.text : ""))
          .join(" ")
          .trim() ?? "(chat)";

  try {
    const resolved = await resolveAgentModel(options, "chat");
    modelChain = resolved.modelChain;
    const result = streamText({
      model: resolved.model,
      abortSignal: modelAbortSignal(options),
      system: buildSystemPrompt(ctx),
      messages,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps),
      onFinish: async ({ text, totalUsage, steps, finishReason }) => {
        // Persist only turns that actually touched the bundle.
        if (recorder.steps.length > 0) {
          const usage =
            totalUsage && (totalUsage.inputTokens != null || totalUsage.outputTokens != null)
              ? { inputTokens: totalUsage.inputTokens ?? 0, outputTokens: totalUsage.outputTokens ?? 0 }
              : undefined;
          const outcome = hitStepLimit({ steps, finishReason }, maxSteps) ? "step-limit" : "success";
          await traceStore(kb).save(recorder.finalize("chat", input, text, outcome, modelChain, usage));
        }
      },
    });
    return { result, filesChanged };
  } catch (err) {
    const outcome = filesChanged.size > 0 ? "partial" : "failed";
    await traceStore(kb).save(recorder.finalize("chat", input, errorMessage(err), outcome, modelChain));
    throw err;
  }
}
