import type { InputRequest } from "#shared/input.js";

/** Returns true when the request gates an AI SDK tool call. */
export function isApprovalRequest(request: InputRequest): boolean {
  return request.kind === "tool-approval";
}
