import { randomUUID } from "node:crypto";

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
        `FACTORY_RUN_TOKEN=${token}.`,
        "Alice is processing a manufactured software-factory backlog. Use the workflow tool exactly once, and do not call any of its subagents outside that program.",
        "Create a minimal array of exactly 200 tickets with ids `T-000` through `T-199`. Each ticket must contain only `id`, except `T-000` also has `triageKey` set to FACTORY_RUN_TOKEN:triage and `T-199` also has `reviewKey` set to FACTORY_RUN_TOKEN:review, replacing FACTORY_RUN_TOKEN with the supplied token.",
        "Use Promise.all to run ticket-triage and ticket-review concurrently, passing the complete tickets array to both calls. Use `outputSchema` to request exactly `{ ticketCount: integer, priorityTicket: string, derivedKey: string }` from ticket-triage and `{ ticketCount: integer, accepted: boolean, derivedKey: string }` from ticket-review.",
        "After both complete, call ticket-reproducer with the returned `{ triage, review }` objects and use `outputSchema` to request exactly `{ combinedKey: string, sampleTicket: string, testCase: string }`. Make every listed output field required and allow no additional output fields.",
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

function expectedFactoryOutput(token: string) {
  const triage = {
    derivedKey: `${token}:triage`,
    priorityTicket: "T-000",
    ticketCount: 200,
  };
  const review = {
    accepted: true,
    derivedKey: `${token}:review`,
    ticketCount: 200,
  };
  return {
    reproduction: {
      combinedKey: `${triage.derivedKey}|${review.derivedKey}`,
      sampleTicket: triage.priorityTicket,
      testCase: `test("${token}", () => expect(runSyntheticRegression()).not.toThrow());`,
    },
    review,
    triage,
  };
}

function exactOutput(expected: ReturnType<typeof expectedFactoryOutput>) {
  return (observed: unknown) => structurallyEqual(observed, expected);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(
      ([key, value]) =>
        Object.hasOwn(rightRecord, key) && structurallyEqual(value, rightRecord[key]),
    )
  );
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
