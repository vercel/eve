import { TASK_PROTOCOL_MISMATCH, TASK_PROTOCOL_VERSION } from "#tasks/protocol.js";

const MAX_OPERATION_ID_LENGTH = 256;

/**
 * Added to every accepted create and message response, so a calling eve
 * deployment can verify that this one speaks its task protocol.
 */
export const TASK_PROTOCOL_RESPONSE_FIELD = { taskProtocol: TASK_PROTOCOL_VERSION } as const;

/**
 * Rejects a delegated request from another task protocol version with 409.
 * A request is delegated when it carries a `callback` or a `taskProtocol`;
 * an eve deployment that calls this one as a remote agent sends both, and
 * an older eve sends a callback without a version.
 */
export function rejectTaskProtocolMismatch(payload: Record<string, unknown>): Response | undefined {
  if (payload.callback === undefined && payload.taskProtocol === undefined) return undefined;
  if (payload.taskProtocol === TASK_PROTOCOL_VERSION) return undefined;
  return taskProtocolMismatchResponse({
    sender: "calling deployment",
    sent: payload.taskProtocol,
  });
}

/** The 409 a deployment answers a task protocol message from another version with. */
export function taskProtocolMismatchResponse(input: {
  /** Who sent the message, as the error names it. */
  readonly sender: string;
  readonly sent: unknown;
}): Response {
  const sent =
    typeof input.sent === "number"
      ? `task protocol version ${String(input.sent)}`
      : "no task protocol version (it runs an older eve)";
  return Response.json(
    {
      code: TASK_PROTOCOL_MISMATCH,
      error: `This deployment uses eve task protocol version ${String(TASK_PROTOCOL_VERSION)}, and the ${input.sender} sent ${sent}. Upgrade so both deployments use the same task protocol version.`,
      ok: false,
      ...TASK_PROTOCOL_RESPONSE_FIELD,
    },
    { headers: { "cache-control": "no-store" }, status: 409 },
  );
}

/** Parses the optional replay-stable identity of one session message. */
export function parseOperationIdField(value: unknown): string | Response | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0 && value.length <= MAX_OPERATION_ID_LENGTH) {
    return value;
  }
  return Response.json(
    {
      error: `Expected 'operationId' to be a non-empty string of at most ${String(MAX_OPERATION_ID_LENGTH)} characters.`,
      ok: false,
    },
    { status: 400 },
  );
}
