import type { EveEvalContext } from "eve/evals";

import { CORRECTED_MEASUREMENT } from "../constants";

/**
 * Drives the correction script against one keeper agent: the parent corrects
 * the keeper by `taskId` while the keeper's measurement is still running.
 * Whether the correction joins the keeper's turn or starts its next one, the
 * correction's call settles with the corrected measurement and the parent's
 * turn ends.
 */
export async function correctKeeperWhileItWorks(t: EveEvalContext, tool: string): Promise<void> {
  const corrected = await t.send(
    `NOTEBOOK-CORRECT ${tool} Alice corrects the pier she asked about.`,
  );
  corrected.expectOk();
  corrected.event("task.settled", {
    count: 1,
    data: { callId: "notebook-correction", output: CORRECTED_MEASUREMENT, status: "completed" },
  });
  corrected.messageIncludes(`NOTEBOOK-REPLY ${CORRECTED_MEASUREMENT}`);

  t.event("agent.started", { count: 1, data: { name: tool } });
  t.eventsSatisfy("the correction reaches the task the first call started", (events) => {
    const calls = events.flatMap((event) =>
      event.type === "task.started" && event.data.name === tool ? [event.data] : [],
    );
    return calls.length === 2 && new Set(calls.map((call) => call.taskId)).size === 1;
  });
}
