import { wrapLanguageModel, type LanguageModel } from "ai";

type ResolvedLanguageModel = Extract<LanguageModel, { doGenerate: unknown }>;

export interface FallbackOptions {
  maxInputTokens?: number;
  allowFor?: ("query" | "mutate" | "chat")[];
  /** Opt-in: retry a 429 (rate limit) against the fallback. Off by default. */
  retry429?: boolean;
}

/**
 * Wraps a primary LanguageModel with a fallback. If primary.doGenerate or
 * primary.doStream (setup phase) fails with a retryable error, the fallback
 * is tried instead for that one generation step. Mid-stream failures are NOT
 * retried — they propagate as stream errors.
 */
export function withFallback(
  primary: LanguageModel,
  fallback: LanguageModel,
  opts: FallbackOptions = {}
): LanguageModel {
  const fallbackModel = fallback as ResolvedLanguageModel;
  return wrapLanguageModel({
    model: primary as ResolvedLanguageModel,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (err) {
          if (!isRetryableError(err, opts.retry429)) throw err;
          try {
            return await fallbackModel.doGenerate(params);
          } catch (fallbackErr) {
            throw combinedFallbackError(err, fallbackErr);
          }
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (err) {
          // This only catches stream setup failures. Once a stream has been
          // returned to the caller, later stream errors must propagate; they
          // cannot be transparently failed over without replaying emitted events.
          if (!isRetryableError(err, opts.retry429)) throw err;
          try {
            return await fallbackModel.doStream(params);
          } catch (fallbackErr) {
            throw combinedFallbackError(err, fallbackErr);
          }
        }
      },
    },
  });
}

/**
 * Positive allowlist: retry only on recognized transport/provider failures.
 * 401/403/AbortError are NOT retryable. 429 retries are opt-in via the
 * `retry429` option (wired from LLM_FALLBACK_RETRY_429 by the caller).
 */
export function isRetryableError(err: unknown, retry429?: boolean): boolean {
  if (typeof err === "number") return isRetryableStatusCode(err, retry429);
  if (isAbortError(err)) return false;

  // Check status code first — it is more specific than the generic
  // isRetryable flag. This ensures {statusCode: 429, isRetryable: true}
  // still gates on the retry429 opt-in instead of bypassing it.
  const statusCode = getStatusCode(err);
  if (statusCode != null) return isRetryableStatusCode(statusCode, retry429);

  // AI SDK wraps transport failures in RetryError with isRetryable: true.
  if (getIsRetryable(err)) return true;

  // Walk the error and its cause chain for transport codes.
  const code = getDeepErrorCode(err);
  if (code && isTransportCode(code)) return true;

  // Node/undici network failures surface as TypeError("fetch failed").
  // Match on the message too — an unrelated TypeError from a real bug
  // should propagate, not be silently swallowed by a fallback.
  if (err instanceof TypeError && errorMessage(err).includes("fetch failed")) return true;

  return false;
}

function isRetryableStatusCode(statusCode: number, retry429?: boolean): boolean {
  if (statusCode === 401 || statusCode === 403) return false;
  if (statusCode === 429) return retry429 === true;
  return statusCode === 408 || (statusCode >= 500 && statusCode < 600);
}

function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const value =
    (err as { statusCode?: unknown; status?: unknown }).statusCode ??
    (err as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const value = (err as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function getIsRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { isRetryable?: unknown }).isRetryable === true;
}

/** Walk the error and its cause chain for the first transport-level code. */
function getDeepErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = getErrorCode(err);
  if (code) return code;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") return getDeepErrorCode(cause);
  return undefined;
}

/** Undici/Node transport error codes. */
function isTransportCode(code: string): boolean {
  const codes = [
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ];
  return codes.includes(code);
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

function combinedFallbackError(primaryErr: unknown, fallbackErr: unknown): Error {
  const message =
    `Primary and fallback model calls failed. Primary: ${errorMessage(primaryErr)}; ` +
    `Fallback: ${errorMessage(fallbackErr)}`;
  return new Error(message, { cause: { primary: primaryErr, fallback: fallbackErr } });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
