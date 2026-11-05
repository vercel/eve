import type { SessionCheckpoint } from "#execution/session/checkpoint.js";
import type { OpenTurn } from "#execution/session/open-turn.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { AcceptedInput } from "./session-store.js";

// A session as another process restores it: the checkpoint a successor would continue from, the
// lines its stream recorded, and the inputs it accepted and hasn't read yet. A snapshot taken
// mid-turn also says where that turn goes on, so the restored session continues it.

/**
 * The snapshot's shape. Restore refuses any other: `/1` was the prototype's, which also carried
 * runs and fork points this build doesn't continue.
 */
export const SESSION_SNAPSHOT_FORMAT = "eve.in-process-session/2";

export interface SessionSnapshot {
  readonly format: typeof SESSION_SNAPSHOT_FORMAT;
  readonly sessionId: string;
  /** Read through `migrateSessionCheckpoint` on restore, which refuses one it can't continue. */
  readonly checkpoint: SessionCheckpoint;
  /** The session's stream, one stored line each, as written. */
  readonly lines: readonly string[];
  /**
   * The session was mid-turn: where the turn goes on, which restore continues it from. A step
   * that was running runs again, as Workflow retries one.
   */
  readonly open?: OpenTurn;
  /** What its addresses accepted that no step it recorded has read, oldest first. */
  readonly inputs?: {
    readonly unread: readonly AcceptedInput[];
    /** The `seq` the next accepted input takes. */
    readonly next: number;
  };
  /** The idle timeout's deadline, kept across a restore. */
  readonly deadline?: string;
  /** When the snapshot was taken. */
  readonly takenAt: string;
}

/** The line position a checkpoint has recorded up to: lines past it are a step's in flight. */
export function checkpointPosition(checkpoint: Pick<SessionCheckpoint, "sessionState">): number {
  return storedProjection(checkpoint.sessionState.snapshot.session.state).view.position;
}
