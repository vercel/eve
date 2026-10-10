import type { SessionStreamEvent } from "eve/client";
import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { CORRECTED_MEASUREMENT, NOTEBOOK_CORRECTION } from "../constants";

/**
 * Drives the correction script against one keeper agent: the parent corrects
 * the keeper by `taskId` while the keeper's first turn is still measuring. The
 * correction joins that running turn, so the turn reads it before it completes
 * and its reply settles the correction's call with the corrected measurement.
 */
export async function correctKeeperWhileItWorks(t: EveEvalContext, tool: string): Promise<void> {
  const corrected = await t.send(
    `NOTEBOOK-CORRECT ${tool} Alice corrects the pier she asked about.`,
  );
  corrected.expectOk();
  // One reply settles both calls: the first carries the output, the correction shares it.
  corrected.event("call.settled", {
    count: 1,
    data: { callId: "notebook-measure", output: CORRECTED_MEASUREMENT, outcome: "completed" },
  });
  corrected.event("call.settled", {
    count: 1,
    data: {
      callId: "notebook-correction",
      outcome: "completed",
      outputOf: { callId: "notebook-measure" },
    },
  });
  corrected.messageIncludes(`NOTEBOOK-REPLY ${CORRECTED_MEASUREMENT}`);

  t.event("child.opened", { count: 1, data: { name: tool } });
  t.eventsSatisfy("the correction reaches the task the first call started", (events) => {
    // The first call starts the task; the correction's call reaches the same task.
    const tasks = new Set(
      events.flatMap((event) =>
        event.type === "task.started" && event.data.name === tool ? [event.data.taskId] : [],
      ),
    );
    const reached = events.flatMap((event) =>
      event.type === "call.started" &&
      event.data.taskId !== undefined &&
      tasks.has(event.data.taskId)
        ? [event.data.taskId]
        : [],
    );
    return tasks.size === 1 && reached.length === 2;
  });

  const started = corrected.events.find(
    (event) => event.type === "child.opened" && event.data.name === tool,
  );
  if (started?.type !== "child.opened") return;
  const firstTurn: SessionStreamEvent[] = [];
  for await (const event of corrected.session.agent(started).stream()) {
    firstTurn.push(event);
    if (event.type === "turn.settled") break;
  }
  t.check(
    firstTurn,
    satisfies(
      (events: readonly SessionStreamEvent[]) =>
        events.some(
          (event) =>
            event.type === "delivery.consumed" &&
            event.data.parts.some(
              (part) => part.kind === "text" && part.text.includes(NOTEBOOK_CORRECTION),
            ),
        ),
      "the keeper's first turn reads the correction before it completes",
    ),
  );
}
