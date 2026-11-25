import type { TurnCaller } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session/checkpoint.js";
import type { SessionAnchor, SessionBoot, SessionStart } from "#execution/session/program.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import { storedProjection } from "#harness/session-machine/view.js";

export interface CheckpointBootInput {
  readonly sessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly anchor: SessionAnchor;
  readonly deploymentId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sessionTimeoutControl?: SessionTimeoutControl;
  readonly start?: SessionStart;
  readonly caller?: TurnCaller;
  readonly compactFirst?: boolean;
  readonly rerunFirst?: boolean;
}

export function bootFromCheckpoint(
  checkpoint: SessionCheckpoint,
  input: CheckpointBootInput,
): SessionBoot {
  return {
    admittedDeliveryKeys: checkpoint.admittedDeliveryKeys,
    anchor: input.anchor,
    caller: input.caller,
    capabilities: checkpoint.capabilities,
    deploymentId: input.deploymentId,
    history: checkpoint.history,
    retention: checkpoint.retention,
    serializedContext: input.serializedContext,
    sessionId: input.sessionId,
    sessionState: checkpoint.sessionState,
    sessionTimeoutMs: checkpoint.sessionTimeoutMs,
    sessionWritable: input.sessionWritable,
    start: input.start ?? waitingStart(checkpoint),
    ...(input.sessionTimeoutControl !== undefined && {
      sessionTimeoutControl: input.sessionTimeoutControl,
    }),
    ...(input.compactFirst === true && { compactFirst: true }),
    ...(input.rerunFirst === true && { rerunFirst: true }),
  };
}

function waitingStart(checkpoint: SessionCheckpoint): SessionStart {
  return storedProjection(checkpoint.sessionState.snapshot.session.state).view.session.status ===
    "new"
    ? { kind: "first-message" }
    : { kind: "parked" };
}
