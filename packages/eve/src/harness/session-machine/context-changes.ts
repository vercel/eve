import { contextStarted, runRequested, runSettledFacts, runStarted } from "#harness/facts.js";
import type { Commit } from "#harness/types.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import { openWork } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { toErrorMessage } from "#shared/errors.js";
import { commitOf } from "./commit.js";

// The context family's commits: a compaction change opens, its summary run starts, and the change
// settles, completed or failed, with what its summary run spent.

/** A context change starts. */
export function startChange(data: FactOf<"context.started">["data"]): Commit {
  return commitOf([contextStarted(data)]);
}

/** A change's summary run is asked for and starts, in one commit. */
export function startSummaryRun(input: {
  readonly changeId: string;
  readonly runId: string;
  readonly modelId: string;
}): Commit {
  return commitOf([
    runRequested({ changeId: input.changeId }, input.runId),
    runStarted({ attempt: 0, modelId: input.modelId, runId: input.runId }),
  ]);
}

/**
 * A compaction completes. Its summary run completes when a summary call returned, with what the
 * calls spent; a run that opened and returned nothing is abandoned.
 */
export function completeCompaction(input: {
  readonly changeId: string;
  readonly runId: string;
  readonly runOpen: boolean;
  readonly summarized: boolean;
  readonly usage: Usage | undefined;
}): Commit {
  const { runId } = input;
  return commitOf([
    ...(input.summarized
      ? runSettledFacts({ finishReason: "stop", outcome: "completed", runId, usage: input.usage })
      : input.runOpen
        ? runSettledFacts({ outcome: "abandoned", runId })
        : []),
    {
      data: { changeId: input.changeId, kind: "compaction", outcome: "completed" },
      type: "context.settled",
    },
  ]);
}

/** A change's summary run failed, and the change with it; the run records what it spent. */
export function failChange(
  view: SessionView,
  input: {
    readonly changeId: string;
    readonly error: unknown;
    readonly spent?: { readonly runId: string; readonly usage: Usage };
  },
): Commit {
  if (view.changes[input.changeId]?.status !== "running") return commitOf([]);
  const error = { code: "COMPACTION_FAILED", message: toErrorMessage(input.error) };
  // The writer closes what else the run and its change held.
  const runs = openWork(view, { changeId: input.changeId }).runs;
  const { spent } = input;
  return commitOf([
    ...runs.flatMap(({ runId }) =>
      runSettledFacts({
        error,
        outcome: "failed",
        runId,
        ...(spent?.runId === runId && { usage: spent.usage }),
      }),
    ),
    {
      data: {
        changeId: input.changeId,
        error,
        kind: view.changes[input.changeId]?.kind ?? "compaction",
        outcome: "failed",
      },
      type: "context.settled",
    },
  ]);
}
