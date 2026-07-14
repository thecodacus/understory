import type { LanguageModel } from "ai";

type ResolvedLanguageModel = Extract<LanguageModel, { doGenerate: unknown }>;

export interface FallbackOptions {
  maxInputTokens?: number;
  allowFor?: ("query" | "mutate" | "chat")[];
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
  _opts: FallbackOptions = {}
): LanguageModel {
  const primaryModel = primary as ResolvedLanguageModel;
  const fallbackModel = fallback as ResolvedLanguageModel;
  return {
    ...primaryModel,
    async doGenerate(options) {
      try {
        return await primaryModel.doGenerate(options);
      } catch (err) {
        if (!isRetryableError(err)) throw err;
        try {
          return await fallbackModel.doGenerate(options);
        } catch (fallbackErr) {
          throw combinedFallbackError(err, fallbackErr);
        }
      }
    },
    async doStream(options) {
      try {
        return await primaryModel.doStream(options);
      } catch (err) {
        // This only catches stream setup failures. Once a stream has been
        // returned to the caller, later stream errors must propagate; they
        // cannot be transparently failed over without replaying emitted events.
        if (!isRetryableError(err)) throw err;
        try {
          return await fallbackModel.doStream(options);
        } catch (fallbackErr) {
          throw combinedFallbackError(err, fallbackErr);
        }
      }
    },
  } as LanguageModel;
}

/**
 * Positive allowlist: retry only on recognized transport/provider failures.
 * 401/403/AbortError are NOT retryable. 429 retries are opt-in via
 * LLM_FALLBACK_RETRY_429=true.
 */
export function isRetryableError(err: unknown): boolean {
  if (typeof err === "number") return isRetryableStatusCode(err);
  if (isAbortError(err)) return false;

  // AI SDK wraps transport failures in RetryError with isRetryable: true.
  if (getIsRetryable(err)) return true;

  const statusCode = getStatusCode(err);
  if (statusCode != null) return isRetryableStatusCode(statusCode);

  // Walk the error and its cause chain for transport codes.
  const code = getDeepErrorCode(err);
  if (code && isTransportCode(code)) return true;

  // Node/undici fetch failures commonly surface as TypeError.
  if (err instanceof TypeError) return true;

  return false;
}

function isRetryableStatusCode(statusCode: number): boolean {
  if (statusCode === 401 || statusCode === 403) return false;
  if (statusCode === 429) return process.env.LLM_FALLBACK_RETRY_429 === "true";
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
