import type { EveEvalContext } from "eve/evals";

export type ModelFamily = "gpt-5.6" | "opus-4.8" | "sonnet-5";

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
  t.event("compaction.completed", { count: (count) => count >= 1 });
  t.messageIncludes("REPOSITORY_INSPECTION_COMPLETE");
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
  t.event("compaction.completed", { count: (count) => count >= 1 });
  t.messageIncludes("SOURCE_ANALYSIS_COMPLETE");
}
