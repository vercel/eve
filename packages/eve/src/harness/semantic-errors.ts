import { summarizeKnownModelCallConfigError } from "#harness/model-call-error.js";
import { walkCauseChain } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

/**
 * One recognized failure shape projected into a stable, actionable
 * summary.
 *
 * `id` is the catalog's stable kebab-case identifier for the failure
 * shape — one per remediation, greppable across logs, transcripts, and
 * this codebase. `name` is the short human title used as the display
 * headline; `message` is remediation text written for end users.
 */
export interface SemanticErrorSummary {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

/**
 * Projects any thrown error into its cataloged semantic summary, or
 * `null` when the shape is not recognized — callers then fall back to
 * the raw message plus the full diagnostic dump routed to the log.
 *
 * This is the growth point of the semantic-error catalog. Model-call
 * failures were the first domain (`model-call-error.ts`); when a new
 * raw error shows up in diagnostic logs often enough to deserve a
 * curated message, add a matcher here (or in its domain module) with a
 * new stable `id`. Matchers must key on structural signals (`name`,
 * `code`, cause-chain fields), never on volatile message prose alone.
 *
 * Domain-specific summaries that need call-site context stay at their
 * call site (e.g. `summarizeKnownModelCallRequestError`, which assumes
 * the error came from a model call).
 */
export function summarizeKnownError(error: unknown): SemanticErrorSummary | null {
  return summarizeKnownModelCallConfigError(error) ?? summarizeNetworkError(error);
}

/**
 * Node/undici error codes that identify a failed network dial or a
 * connection dropped mid-request, independent of what the surrounding
 * library wrapped them in.
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Messages that identify a network failure when no structured `code`
 * survived (undici's top-level `fetch failed`, Node's socket teardown).
 * Deliberately narrow: a generic catalog must not sweep in user errors
 * that merely mention networking.
 */
const NETWORK_ERROR_MESSAGES = ["fetch failed", "socket hang up"];

function summarizeNetworkError(error: unknown): SemanticErrorSummary | null {
  const evidence = findNetworkErrorEvidence(error);
  if (evidence === undefined) return null;
  return {
    id: "network-request-failed",
    name: "Network request failed",
    message: `A network request failed before completing (${evidence}). Check your internet connection and that the target service is reachable, then try again.`,
  };
}

function findNetworkErrorEvidence(error: unknown): string | undefined {
  // A structured code anywhere on the chain beats a message match: undici
  // wraps the coded socket error under a generic `fetch failed`, and the
  // code is the evidence worth naming in the summary.
  for (const candidate of walkCauseChain(error)) {
    if (!isObject(candidate)) continue;
    const code = candidate.code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
      return code;
    }
  }
  for (const candidate of walkCauseChain(error)) {
    if (!isObject(candidate)) continue;
    const message = candidate.message;
    if (typeof message === "string") {
      const matched = NETWORK_ERROR_MESSAGES.find((known) => message.toLowerCase().includes(known));
      if (matched !== undefined) return matched;
    }
  }
  return undefined;
}
