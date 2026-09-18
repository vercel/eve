import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const TRIAGE = "ticket-triage";
const REVIEW = "ticket-review";
const REPRODUCE = "ticket-reproducer";

/** A workflow fans out ticket analysis and feeds both derived results into reproduction. */
export default defineEval({
  tags: ["real-model"],
  description:
    "The root agent runs parallel triage and review over 200 tickets, then passes both derived outputs into reproduction.",
  async test(t) {
    const token = randomUUID();
    const expected = expectedFactoryOutput(token);
    const turn = await t.send(
      [
        `Alice's QA batch id is ${token}.`,
        "Alice is preparing a QA summary for a sample software backlog. Use the workflow tool exactly once, and call its subagents only from that program.",
        `Create a minimal array of exactly 200 tickets with ids \`T-000\` through \`T-199\`. Each ticket must contain only \`id\`, except \`T-000\` also has \`triageLabel\` set to \`TRIAGE-${token}\` and \`T-199\` also has \`reviewLabel\` set to \`REVIEW-${token}\`.`,
        "Use Promise.all to run ticket-triage and ticket-review concurrently, passing the complete tickets array to both calls. Use `outputSchema` to request exactly `{ ticketCount: integer, priorityTicket: string, summaryLabel: string }` from ticket-triage and `{ ticketCount: integer, accepted: boolean, summaryLabel: string }` from ticket-review.",
        "After both complete, call ticket-reproducer with the returned `{ triage, review }` objects as JSON. The reproducer already has its output rules; pass the objects without adding formatting instructions. Use `outputSchema` to request exactly `{ combinedLabel: string, sampleTicket: string, verificationNote: string }`. Make every listed output field required and allow no additional output fields.",
        "Return `{ reproduction, review, triage }` and reply with only that returned JSON object.",
      ].join(" "),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("workflow", {
      count: 1,
      output: (observed) => isDeepStrictEqual(observed, expected),
    });
    t.calledSubagent(TRIAGE, { count: 1, status: "completed" });
    t.calledSubagent(REVIEW, { count: 1, status: "completed" });
    t.calledSubagent(REPRODUCE, { count: 1, status: "completed" });
    turn.eventsSatisfy("analysis fans out before reproduction consumes both results", (events) => {
      const called = new Map<string, number>();
      for (const [index, event] of events.entries()) {
        if (event.type === "subagent.called" && !called.has(event.data.name)) {
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
    await t.require(parseJsonMessage(turn.message), equals(expected));
    t.noFailedActions();
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
