import type { EveEvalContext } from "eve/evals";

import type { ModelFamily } from "./agent";
import { SECOND_CHECKPOINT_MARKER } from "./constants";

export async function testRedundantToolCalls(
  t: EveEvalContext,
  modelFamily: ModelFamily,
): Promise<void> {
  const turn = await t.send(
    [
      `[model: ${modelFamily}]`,
      "[case: redundant-tool-calls]",
      "Call inspect-repository exactly once with scope repository.",
      "After it succeeds, report REPOSITORY_INSPECTION_COMPLETE and call no more tools.",
    ].join("\n"),
  );

  turn.expectOk();
  t.succeeded();
  t.calledTool("inspect-repository", {
    count: 1,
    input: { scope: "repository" },
    output: { completed: true, completionMarker: "REPOSITORY_INSPECTION_COMPLETE" },
  });
  t.calledTool("advance-checkpoint", {
    count: 1,
    output: { checkpointMarker: SECOND_CHECKPOINT_MARKER, completed: true },
  });
  t.event("compaction.completed", { count: 2 });
  t.messageIncludes("REPOSITORY_INSPECTION_COMPLETE");
  t.messageIncludes(SECOND_CHECKPOINT_MARKER);
}

export async function testStaleTodoWork(
  t: EveEvalContext,
  modelFamily: ModelFamily,
): Promise<void> {
  const turn = await t.send(
    [
      `[model: ${modelFamily}]`,
      "[case: stale-todo-work]",
      "Call perform-source-analysis exactly once with approach initial.",
      "The tool deliberately leaves its completed work in a pending todo.",
      "After it succeeds, report SOURCE_ANALYSIS_COMPLETE and call no more tools.",
    ].join("\n"),
  );

  turn.expectOk();
  t.succeeded();
  t.calledTool("perform-source-analysis", {
    count: 1,
    output: { completed: true, workUnit: "source-analysis" },
  });
  t.calledTool("advance-checkpoint", {
    count: 1,
    output: { checkpointMarker: SECOND_CHECKPOINT_MARKER, completed: true },
  });
  t.event("compaction.completed", { count: 2 });
  t.messageIncludes("SOURCE_ANALYSIS_COMPLETE");
  t.messageIncludes(SECOND_CHECKPOINT_MARKER);
}
