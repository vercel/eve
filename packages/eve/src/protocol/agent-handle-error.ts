/** JSON error returned when an agent-handle operation cannot be completed. */
export interface AgentHandleErrorJson<TCode extends string = string> {
  readonly code: TCode;
  readonly error: string;
  readonly ok: false;
}

function defineAgentHandleError<const TCode extends string>(
  code: TCode,
  message: string,
): {
  readonly code: TCode;
  readonly toJson: () => AgentHandleErrorJson<TCode>;
} {
  return {
    code,
    toJson: () => ({ code, error: message, ok: false }),
  };
}

/** Stable agent-handle errors shared by HTTP producers and consumers. */
export const AgentHandleError = {
  SessionNotResumable: defineAgentHandleError(
    "SESSION_NOT_RESUMABLE",
    "Session is not active and cannot be resumed.",
  ),
} as const;
