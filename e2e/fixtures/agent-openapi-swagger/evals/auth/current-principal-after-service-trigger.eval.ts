import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const CONNECTION = "clickstate";
const SEARCH_TOOL = "connection_search";
const SERVICE_COMPLETE = "AUTOMATED_INVESTIGATION_COMPLETE";

export default defineEval({
  description:
    "A human can authorize a user-scoped connection after the service turn records a principal error.",

  async test(t) {
    const serviceTurn = await t.send({
      headers: { authorization: "Bearer e2e-current-auth-service" },
      message: [
        "Automated trigger: investigate a synthetic deployment alert.",
        "Call `connection_search` exactly once with connection `clickstate` and keywords `workflow runs`.",
        "After the expected service-principal failure, do not retry or use another tool.",
        `Reply with exactly: ${SERVICE_COMPLETE}`,
      ].join("\n"),
    });
    serviceTurn.expectOk();
    serviceTurn.calledTool(SEARCH_TOOL, {
      count: 1,
      input: { connection: CONNECTION },
      output: /active session is scoped to "service"/iu,
      status: "failed",
    });
    serviceTurn.notEvent("authorization.required", {
      data: { name: CONNECTION },
    });
    serviceTurn.messageIncludes(SERVICE_COMPLETE);
    serviceTurn.eventsSatisfy(
      "the failed search result reaches a later model step before the service turn completes",
      serviceFailurePrecedesCompletion,
    );

    const humanTurn = await t.send({
      headers: { authorization: "Bearer e2e-current-auth-user" },
      message: "@sre can u check clickstate bro?",
    });
    humanTurn.expectOk();

    await t.require(humanTurn.sessionId, equals(serviceTurn.sessionId));
    humanTurn.calledTool(SEARCH_TOOL, {
      count: 1,
      input: { connection: CONNECTION },
      status: "pending",
    });
    humanTurn.event("authorization.required", {
      count: 1,
      data: {
        authorization: {
          instructions: "CLICKSTATE_CURRENT_PRINCIPAL=user:e2e-human",
        },
        name: CONNECTION,
      },
    });
  },
});

function serviceFailurePrecedesCompletion(events: readonly HandleMessageStreamEvent[]): boolean {
  const failureIndex = events.findIndex(
    (event) =>
      event.type === "action.result" &&
      event.data.status === "failed" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === SEARCH_TOOL,
  );
  const failure = events[failureIndex];
  if (failure?.type !== "action.result") return false;

  const nextStepIndex = events.findIndex(
    (event, eventIndex) =>
      eventIndex > failureIndex &&
      event.type === "step.started" &&
      event.data.stepIndex === failure.data.stepIndex + 1,
  );
  if (nextStepIndex < 0) return false;

  return events
    .slice(nextStepIndex + 1)
    .some(
      (event) =>
        event.type === "message.completed" &&
        event.data.stepIndex === failure.data.stepIndex + 1 &&
        event.data.finishReason !== "tool-calls" &&
        event.data.message === SERVICE_COMPLETE,
    );
}
