/** Derives the private cancellation hook token for one dispatched turn. */
export function turnCancellationHookToken(controlToken: string): string {
  // The stream namespace is canonical ASCII. Fixed-width UTF-16 code units
  // retain every control-token boundary, unlike delimiter replacement.
  let encoded = "";
  for (let index = 0; index < controlToken.length; index += 1) {
    encoded += controlToken.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `abrt_${encoded}_cancel`;
}

/** Payload delivered to the active-step abort stream. */
export interface TurnCancellationPayload {
  readonly reason: unknown;
}
