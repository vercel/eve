/** Derives the private cancellation hook token for one dispatched turn. */
export function turnCancellationHookToken(controlToken: string): string {
  // `controlToken` is Eve-generated as `${sessionId}:turn-control:${index}`.
  // The active-step abort stream uses this token in its stream name, so keep
  // the deterministic mapping portable to filesystem-backed Workflow worlds.
  return `abrt_${controlToken.replaceAll(":", "_")}_cancel`;
}

/** Payload delivered to the active-step abort stream. */
export interface TurnCancellationPayload {
  readonly reason: unknown;
}
