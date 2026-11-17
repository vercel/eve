import { codeIs, messageIs, type SemanticErrorRule } from "../rule.js";

const NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
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
  {
    id: "network-request-failed",
    name: "Network request failed",
    tags: ["system", "transient"],
    when: codeIs(...NETWORK_ERROR_CODES),
    message: (link) => networkFailureMessage(link.code ?? "network error"),
    hint: NETWORK_FAILURE_HINT,
  },
  {
    id: "network-request-failed",
    name: "Network request failed",
    tags: ["system", "transient"],
    when: messageIs("fetch failed", "socket hang up", "terminated"),
    message: (link) => networkFailureMessage(link.message.trim()),
    hint: NETWORK_FAILURE_HINT,
  },
];

function networkFailureMessage(evidence: string): string {
  return `A network request failed before completing (${evidence}).`;
}
