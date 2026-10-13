import { Agent, fetch as undiciFetch } from "undici";

/**
 * Node's built-in fetch gives up when no response header arrives within
 * 300 s, and again when the body goes quiet for 300 s. An agent run is one
 * non-streaming request per step, so a local model that needs longer than
 * that for a single completion (a long prefill is enough) could never answer.
 * LLM requests therefore use a dispatcher without those two limits. The
 * deadline is LLM_TIMEOUT when one is set, and a caller's abort still cancels
 * the request. Connecting keeps its own short timeout, so an unreachable
 * endpoint fails fast.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

type UndiciFetchArgs = Parameters<typeof undiciFetch>;

export const llmFetch = ((input: UndiciFetchArgs[0], init?: UndiciFetchArgs[1]) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
