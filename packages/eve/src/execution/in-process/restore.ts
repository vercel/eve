import type { CheckpointBootInput } from "#execution/session/checkpoint-boot.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { stampSessionIdentity } from "#execution/session/owner-boot.js";
import type { SessionCheckpoint } from "#execution/session/checkpoint.js";
import { deliveriesReadBy } from "#execution/session/open-turn.js";
import { runRecordOf, type RunSnapshot } from "./runs.js";
import { deliveryIdOf } from "./session-record.js";
import type { AcceptedInput } from "./session-store.js";
import {
  checkpointPosition,
  lineCount,
  SESSION_SNAPSHOT_FORMAT,
  type SessionSnapshot,
} from "./snapshot.js";

// What restoring a snapshot does, decided before anything runs. The runtime applies the plan:
// it opens the stream, claims the addresses, queues what the plan redelivers, reports each lost
// run, starts the runs that go on, and boots the session from its checkpoint
// (`checkpoint-boot.ts`).

export interface RestorePlan {
  /** The checkpoint as this build continues it. */
  readonly checkpoint: SessionCheckpoint;
  /** How the session boots from it: its context, where its open turn goes on, and whether its first step reruns. */
  readonly boot: Pick<CheckpointBootInput, "rerunFirst" | "serializedContext" | "start">;
  /**
   * What the session accepted and no saved step read, in the order it arrived: but what the step
   * the open turn goes on with reads from its own input.
   */
  readonly redeliver: readonly AcceptedInput[];
  /** The idle timeout's deadline, kept across the restore. */
  readonly deadline: Date | undefined;
  /**
   * Replayable runs that go on (subagents', `ask_question`'s): the store kept the sessions they
   * opened. Each skips the messages the session heard from it.
   */
  readonly resumedRuns: readonly { readonly run: RunSnapshot; readonly heard: number }[];
  /** Runs that don't survive, each reported once as interrupted. */
  readonly lostRuns: readonly RunSnapshot[];
}

/**
 * Plans restoring `snapshot`. With a store (`hasStore`), the sessions a replayable run opened are
 * kept there, so the run goes on; without one, every run is lost. A snapshot this build can't
 * continue is refused, with why.
 */
export function planRestore(
  snapshot: SessionSnapshot,
  options: { readonly hasStore: boolean },
): RestorePlan {
  const refuse = (why: string) =>
    new Error(`Session "${snapshot.sessionId}" can't be restored here: ${why}.`);
  if (snapshot.format !== SESSION_SNAPSHOT_FORMAT)
    throw refuse(
      `its snapshot is in format "${String(snapshot.format)}", and this build reads "${SESSION_SNAPSHOT_FORMAT}"`,
    );
  const migration = migrateSessionCheckpoint(snapshot.checkpoint);
  if (migration.kind !== "current")
    throw refuse(
      migration.kind === "pre-v27"
        ? "an eve before v27 recorded it, which only a deployment can continue"
        : migration.detail,
    );
  const { checkpoint } = migration;
  const { open } = snapshot;
  const reading = new Set(deliveriesReadBy(open));
  const runs = snapshot.runs ?? [];
  const goesOn = (run: RunSnapshot) => options.hasStore && runRecordOf(run).replayable;
  return {
    boot: {
      rerunFirst: lineCount(snapshot) > checkpointPosition(checkpoint),
      serializedContext: stampSessionIdentity(checkpoint.serializedContext, snapshot.sessionId),
      ...(open !== undefined && { start: { from: open, kind: "resume" } }),
    },
    checkpoint,
    deadline: snapshot.deadline === undefined ? undefined : new Date(snapshot.deadline),
    lostRuns: runs.filter((run) => !goesOn(run)),
    redeliver: (snapshot.inputs?.unread ?? []).filter(
      (input) => !("command" in input) || !reading.has(deliveryIdOf(input.command) ?? ""),
    ),
    resumedRuns: runs
      .filter(goesOn)
      .map((run) => ({ heard: snapshot.inputs?.heard?.[run.runId] ?? 0, run })),
  };
}
