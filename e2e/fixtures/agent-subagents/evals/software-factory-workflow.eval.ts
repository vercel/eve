import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const TRIAGE = "ticket-triage";
const REVIEW = "ticket-review";
const REPRODUCE = "ticket-reproducer";

const EXPECTED_OUTPUT = {
  reproduction: {
    command: "pnpm test reproductions/T-000.test.ts",
    files: ["reproductions/T-000.test.ts"],
    sampleTicket: "T-000",
    testCase: 'test("T-000 reproduction", () => expect(runSyntheticRegression()).not.toThrow());',
  },
  review: {
    accepted: true,
    risks: ["shared regression pattern", "cross-area impact"],
    summary: "REVIEW_STAGE_COMPLETE",
    ticketCount: 200,
  },
  triage: {
    priorityTickets: ["T-000", "T-004", "T-008"],
    themes: ["TRIAGE_STAGE_COMPLETE", "api", "cli", "runtime", "docs"],
    ticketCount: 200,
  },
};

/** A model-authored workflow fans out ticket analysis and feeds both results into reproduction. */
export default defineEval({
  tags: ["real-model"],
  description:
    "The root agent runs parallel triage and review over 200 tickets, then passes both outputs into reproduction.",
  async test(t) {
    const turn = await t.send(
      [
        "Alice is processing a manufactured software-factory backlog. Use the workflow tool exactly once, and do not call any of its subagents outside workflow.",
        "Create 200 synthetic tickets with zero-padded T- ids, areas selected from api, cli, runtime, and docs, severities, and regression titles.",
        "Use Promise.all to run ticket-triage and ticket-review concurrently. Pass the complete tickets array to both calls.",
        "Request triage output with integer ticketCount, string-array priorityTickets, and string-array themes.",
        "Request review output with integer ticketCount, boolean accepted, string summary, and string-array risks.",
        "After both complete, call ticket-reproducer with both `{ triage, review }` results. Request string sampleTicket, string-array files, string command, and string testCase.",
        "Return `{ triage, review, reproduction }` and reply with only that returned JSON object.",
      ].join(" "),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    t.calledSubagent(TRIAGE, { count: 1 });
    t.calledSubagent(REVIEW, { count: 1 });
    t.calledSubagent(REPRODUCE, { count: 1 });
    turn.eventsSatisfy("analysis fans out before reproduction consumes both results", (events) => {
      const called = new Map<string, number>();
      const completed = new Map<string, number>();
      for (const [index, event] of events.entries()) {
        if (event.type === "subagent.called" && !called.has(event.data.name)) {
          called.set(event.data.name, index);
        }
        if (event.type === "subagent.completed" && !completed.has(event.data.subagentName)) {
          completed.set(event.data.subagentName, index);
        }
      }

      const triageCalled = called.get(TRIAGE);
      const reviewCalled = called.get(REVIEW);
      const triageCompleted = completed.get(TRIAGE);
      const reviewCompleted = completed.get(REVIEW);
      const reproduceCalled = called.get(REPRODUCE);
      const reproduceCompleted = completed.get(REPRODUCE);
      if (
        triageCalled === undefined ||
        reviewCalled === undefined ||
        triageCompleted === undefined ||
        reviewCompleted === undefined ||
        reproduceCalled === undefined ||
        reproduceCompleted === undefined
      ) {
        return false;
      }

      return (
        Math.max(triageCalled, reviewCalled) < Math.min(triageCompleted, reviewCompleted) &&
        Math.max(triageCompleted, reviewCompleted) < reproduceCalled &&
        reproduceCalled < reproduceCompleted
      );
    });
    await t.require(parseJsonMessage(turn.message), equals(EXPECTED_OUTPUT));
    t.noFailedActions();
  },
});

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
