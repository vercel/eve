import { randomUUID } from "node:crypto";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  SOFTWARE_FACTORY_EVAL_MARKER,
  expectedFactoryOutput,
  type FactoryOutput,
} from "../agent/software-factory";

const TRIAGE = "ticket-triage";
const REVIEW = "ticket-review";
const REPRODUCE = "ticket-reproducer";

/** A workflow fans out ticket analysis and feeds both derived results into reproduction. */
export default defineEval({
  description:
    "The root agent runs parallel triage and review over 200 tickets, then passes both derived outputs into reproduction.",
  async test(t) {
    const token = randomUUID();
    const expected = expectedFactoryOutput(token);
    const turn = await t.send(
      [
        `${SOFTWARE_FACTORY_EVAL_MARKER} FACTORY_RUN_TOKEN=${token}.`,
        "Alice is processing a manufactured software-factory backlog. Use the workflow tool exactly once, and do not call any of its subagents outside workflow.",
        "Create 200 synthetic tickets with unique zero-padded T- ids. Put the value FACTORY_RUN_TOKEN:triage in `triageKey` on the first ticket and FACTORY_RUN_TOKEN:review in `reviewKey` on the last ticket, replacing FACTORY_RUN_TOKEN with the supplied token.",
        "Use Promise.all to run ticket-triage and ticket-review concurrently, passing the complete tickets array to both calls with structured output schemas.",
        "After both complete, call ticket-reproducer with the returned `{ triage, review }` objects and a structured output schema.",
        "Return `{ reproduction, review, triage }` and reply with only that returned JSON object.",
      ].join(" "),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("workflow", { count: 1, output: exactOutput(expected) });
    t.calledSubagent(TRIAGE, { count: 1, status: "pending" });
    t.calledSubagent(REVIEW, { count: 1, status: "pending" });
    t.calledSubagent(REPRODUCE, { count: 1, status: "pending" });
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

function exactOutput(expected: FactoryOutput) {
  return (observed: unknown) => JSON.stringify(observed) === JSON.stringify(expected);
}

function parseJsonMessage(message: string | undefined): unknown {
  if (message === undefined) return undefined;
  try {
    return JSON.parse(message.trim());
  } catch {
    return undefined;
  }
}
