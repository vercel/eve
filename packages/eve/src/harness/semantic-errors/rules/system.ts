import { codeIs, messageIs, type SemanticErrorRule } from "../rule.js";

/**
 * Node/undici error codes that identify a failed network dial or a
 * connection dropped mid-request, independent of what the surrounding
 * library wrapped them in.
 */
const NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

const NETWORK_FAILURE_HINT =
  "Check your internet connection and that the target service is reachable, then try again.";

export const SYSTEM_RULES: readonly SemanticErrorRule[] = [
  {
    id: "port-already-in-use",
    name: "Port already in use",
    tags: ["system", "config"],
    when: codeIs("EADDRINUSE"),
    message:
      "The port is already in use — another process (perhaps another `eve dev`) is listening on it.",
    hint: "Stop that process or pass a different `--port`.",
  },
  {
    id: "disk-full",
    name: "Disk full",
    tags: ["system"],
    when: codeIs("ENOSPC"),
    message: "The disk is full, so writes are failing.",
    hint: "Free up space and retry.",
  },
  // One failure shape, two detection signals in priority order: a
  // structured code anywhere on the chain beats a message match, because
  // undici wraps the coded socket error under a generic `fetch failed`
  // and the code is the evidence worth naming in the summary.
  {
    id: "network-request-failed",
    name: "Network request failed",
    tags: ["system", "transient"],
    when: codeIs(...NETWORK_ERROR_CODES),
    message: (link) => networkFailureMessage(link.code ?? "network error"),
    hint: NETWORK_FAILURE_HINT,
  },
  {
    // Exact-equality message fallback, verified empirically on Node 26:
    // a failed `fetch` rejects with a TypeError whose message is exactly
    // "fetch failed" (the coded cause is sometimes stripped in transit),
    // and a peer-destroyed HTTP socket errors with exactly "socket hang
    // up" (code ECONNRESET — the code rule above normally wins).
    // Equality, never containment: a user error that merely mentions
    // "fetch failed" must not be reclassified as a connectivity problem.
    id: "network-request-failed",
    name: "Network request failed",
    tags: ["system", "transient"],
    when: messageIs("fetch failed", "socket hang up"),
    message: (link) => networkFailureMessage(link.message.trim()),
    hint: NETWORK_FAILURE_HINT,
  },
];

function networkFailureMessage(evidence: string): string {
  return `A network request failed before completing (${evidence}).`;
}
