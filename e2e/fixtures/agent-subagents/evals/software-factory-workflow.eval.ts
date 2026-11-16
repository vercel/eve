import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const TRIAGE = "ticket-triage";
const REVIEW = "ticket-review";
const REPRODUCE = "ticket-reproducer";

/** One background program fans out ticket analysis and feeds both structured results into reproduction. */
export default defineEval({
  tags: ["real-model"],
  description:
    "One workflow program runs triage and review over 200 tickets at once with outputSchema, then passes both structured results to reproduction, and returns them as its task's result.",
  async test(t) {
    const token = randomUUID();
    const expected = expectedFactoryOutput(token);
    const turn = await t.send(
      [
        `Alice's QA batch id is ${token}.`,
        "Alice is preparing a QA summary for a sample software backlog, and wants the pipeline to run in the background. Please call the workflow tool exactly once with one program for the whole pipeline, and ask the ticket agents only from that workflow program, not directly and not from eve__execute.",
        `In the program, build an array of exactly 200 tickets with ids \`T-000\` through \`T-199\`. Each ticket contains only \`id\`, except \`T-000\` also has \`triageLabel\` set to \`TRIAGE-${token}\` and \`T-199\` also has \`reviewLabel\` set to \`REVIEW-${token}\`.`,
        "Ask ticket-triage and ticket-review together with Promise.all, giving each the complete tickets array as JSON in its message. Pass `outputSchema` beside `message` to request exactly `{ ticketCount: integer, priorityTicket: string, summaryLabel: string }` from ticket-triage and `{ ticketCount: integer, accepted: boolean, summaryLabel: string }` from ticket-review.",
        "After both answer, ask ticket-reproducer with the returned `{ triage, review }` objects as JSON. The reproducer already has its output rules, so pass the objects without adding formatting instructions. Request exactly `{ combinedLabel: string, sampleTicket: string, verificationNote: string }` with `outputSchema`. Make every listed output field required and allow no additional output fields.",
        "Return `{ reproduction, review, triage }` from the program. Wait for the task, then reply with only the JSON object the program returned, which is the `result` field of the task's result.",
      ].join(" "),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    // The workflow tool runs as a task: the program's value settles the task, not the call.
    t.event("task.started", { count: 1, data: { name: "workflow" } });
    t.event("call.settled", {
      count: 1,
      data: {
        outcome: "completed",
        output: (observed) =>
          isDeepStrictEqual((observed as { readonly result?: unknown } | null)?.result, expected),
      },
    });
    t.event("child.opened", { count: 1, data: { name: TRIAGE } });
    t.event("child.opened", { count: 1, data: { name: REVIEW } });
    t.event("child.opened", { count: 1, data: { name: REPRODUCE } });
    turn.eventsSatisfy("analysis fans out before reproduction consumes both results", (events) => {
      const called = new Map<string, number>();
      for (const [index, event] of events.entries()) {
        if (event.type === "child.opened" && !called.has(event.data.name)) {
          called.set(event.data.name, index);
        }
      }

      const triageCalled = called.get(TRIAGE);
      const reviewCalled = called.get(REVIEW);
      const reproduceCalled = called.get(REPRODUCE);
      return (
        triageCalled !== undefined &&
        reviewCalled !== undefined &&
        reproduceCalled !== undefined &&
        Math.max(triageCalled, reviewCalled) < reproduceCalled
      );
    });
    await t.require(parseJsonMessage(turn.reply), equals(expected));
    t.noFailedCalls();
  },
});

function expectedFactoryOutput(token: string) {
  const triage = {
    priorityTicket: "T-000",
    summaryLabel: `TRIAGE-${token}`,
    ticketCount: 200,
  };
  const review = {
    accepted: true,
    summaryLabel: `REVIEW-${token}`,
    ticketCount: 200,
  };
  return {
    reproduction: {
      combinedLabel: `${triage.summaryLabel}|${review.summaryLabel}`,
      sampleTicket: triage.priorityTicket,
      verificationNote: `Check QA batch ${token} using ticket T-000.`,
    },
    review,
    triage,
  };
}

function parseJsonMessage(message: string | undefined): unknown {
  if (message === undefined) return undefined;
  const trimmed = message.trim();
  const source = trimmed.startsWith("```json")
    ? trimmed.slice("```json".length, trimmed.endsWith("```") ? -3 : undefined).trim()
    : trimmed;
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}
