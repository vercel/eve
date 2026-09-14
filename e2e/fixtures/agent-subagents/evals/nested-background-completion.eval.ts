import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { NESTED_COMPLETION_PARENT_SCENARIO } from "../constants";

const REVIEW_RESULT = "REVIEW_VERDICT_CEDAR_947";

type SessionDriver = Pick<
  EveEvalSession,
  "pendingInputRequests" | "respond" | "sessionId" | "state"
>;

/** A remote child must keep its caller while an invocation-owned nested review is pending. */
export default defineEval({
  description:
    "A remote child's interim acknowledgement does not complete its parent task before a gated nested reviewer returns.",
  async test(t) {
    const started = await t.send(NESTED_COMPLETION_PARENT_SCENARIO);
    started.expectOk();
    const receipt = started.events.find(
      (event) =>
        event.type === "subagent.completed" &&
        event.data.subagentName === "remote-loopback" &&
        event.data.backgroundTask !== undefined,
    );
    if (receipt?.type !== "subagent.completed" || receipt.data.backgroundTask === undefined) {
      throw new Error("The remote invocation returned no background task receipt.");
    }
    const parentTaskId = receipt.data.backgroundTask.taskId;

    const parentLive = watchNextTurn(t, t, "background completion wait");
    const remoteCall = await parentLive.waitForEvent("subagent.called", {
      data: { callId: receipt.data.callId },
    });

    const childAcknowledgementLive = t.target.watchTurn(remoteCall.data.childSessionId);
    const childAcknowledgement = await childAcknowledgementLive.result();
    childAcknowledgement.expectOk();
    childAcknowledgement.messageIncludes("Reviewing...");

    let child = childAcknowledgementLive.session;
    let reviewRequest = child.pendingInputRequests.find(
      (request) => request.action.toolName === "review_gate",
    );
    if (reviewRequest === undefined) {
      const reviewGateLive = watchNextTurn(t, child, "review gate wait");
      const requested = await reviewGateLive.waitForEvent("input.requested", {
        data: {
          requests: (requests) =>
            requests.some((request) => request.action.toolName === "review_gate"),
        },
      });
      child = reviewGateLive.session;
      reviewRequest = requested.data.requests.find(
        (request) => request.action.toolName === "review_gate",
      );
    }
    if (reviewRequest === undefined) {
      throw new Error("The nested reviewer emitted no approval request.");
    }

    const parentBeforeApproval = [...started.events, ...parentLive.events];
    await t.require(
      parentBeforeApproval,
      satisfies(
        (events: typeof parentBeforeApproval) =>
          !events.some((event) => isTaskCompletion(event, parentTaskId)),
        "the parent task remains pending while the nested reviewer is gated",
      ),
    );

    const approved = await child.respond([
      { optionId: "approve", requestId: reviewRequest.requestId },
    ]);
    approved.noFailedActions();
    approved.expectOk();

    const completedParent = await parentLive.result();
    completedParent.noFailedActions();
    completedParent.expectOk();
    completedParent.messageIncludes(REVIEW_RESULT);

    const parentEvents = [...started.events, ...parentLive.events];
    await t.require(
      parentEvents,
      satisfies(
        (events: typeof parentEvents) =>
          events.filter((event) => isTaskCompletion(event, parentTaskId)).length === 1,
        "the delegated invocation settles exactly once",
      ),
    );
    t.noFailedActions();
  },
});

function watchNextTurn(t: EveEvalContext, session: SessionDriver, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}

function isTaskCompletion(event: EveEvalSession["events"][number], taskId: string): boolean {
  if (event.type !== "message.received") return false;
  const message = messageText(event.data.message);
  return message.includes(`Background task ${taskId}`) && message.includes(" is completed.");
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      Reflect.get(part, "type") === "text" &&
      typeof Reflect.get(part, "text") === "string"
        ? [Reflect.get(part, "text") as string]
        : [],
    )
    .join("\n");
}
