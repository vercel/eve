import type { TurnCaller } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session/checkpoint.js";
import type { SessionAnchor, SessionBoot, SessionStart } from "#execution/session/program.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import { storedProjection } from "#harness/session-machine/view.js";

// The boot of an owner that continues a session from its checkpoint: a Workflow successor that
// received the session, or another host restoring it. Each maps the checkpoint the same way; they
// differ only in where the session runs, who it reports to, and what it starts with.

export interface CheckpointBootInput {
  readonly sessionId: string;
  /** The checkpoint's context, as this owner continues it (its identity stamped). */
  readonly serializedContext: Record<string, unknown>;
  readonly anchor: SessionAnchor;
  readonly deploymentId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /** The session's idle timeout, when it has one. */
  readonly sessionTimeoutControl?: SessionTimeoutControl;
  /** What the session does first: by default, waits for its next input as it was. */
  readonly start?: SessionStart;
  readonly caller?: TurnCaller;
  readonly compactFirst?: boolean;
  readonly rerunFirst?: boolean;
}

/** The boot that continues `checkpoint`. */
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

/** A session that never had a message waits for its first; any other, for its next. */
function waitingStart(checkpoint: SessionCheckpoint): SessionStart {
  return storedProjection(checkpoint.sessionState.snapshot.session.state).view.session.status ===
    "new"
    ? { kind: "first-message" }
    : { kind: "parked" };
}
