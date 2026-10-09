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
  corrected.event("call.settled", {
    count: 1,
    data: { callId: "notebook-correction", output: CORRECTED_MEASUREMENT, outcome: "completed" },
  });
  corrected.messageIncludes(`NOTEBOOK-REPLY ${CORRECTED_MEASUREMENT}`);

  t.event("child.opened", { count: 1, data: { name: tool } });
  t.eventsSatisfy("the correction reaches the task the first call started", (events) => {
    const calls = events.flatMap((event) =>
      event.type === "task.started" && event.data.name === tool ? [event.data] : [],
    );
    return calls.length === 2 && new Set(calls.map((call) => call.taskId)).size === 1;
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
