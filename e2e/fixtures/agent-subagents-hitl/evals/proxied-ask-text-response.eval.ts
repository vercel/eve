import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";

/** A human text answer resolves the child's proxied request at the parent by request ID. */
export default defineEval({
  description: "Plain-text approval at the parent resumes a delegated child's ctx.ask().",
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send(
      "Call the approval-child subagent exactly once. Acknowledge its receipt and relay its final result when it completes.",
    );
    let parent = started.session;
    let called = started.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "approval-child",
    );
    if (called?.type !== "subagent.called") {
      const live = watchNextTurn(t, parent, "approval child dispatch wait");
      called = await live.waitForEvent("subagent.called", { data: { name: "approval-child" } });
      parent = live.session;
    }
    if (called.type !== "subagent.called") throw new Error("Approval child was not called.");
    const childTurn = t.target.watchTurn(called.data.childSessionId);
    const pending = await waitForInput(t, parent);
    const request = pending.requireInputRequest({
      prompt: /Approve the deployment/i,
      toolName: "ask_question",
    });
    const parkedChild = await childTurn.result();

    const resumedChild = t.target.watchTurn(called.data.childSessionId, {
      startIndex: parkedChild.session.state.streamIndex,
    });
    const approved = await pending.start("approve");
    const resolution = await waitForObservedEvent(resumedChild, "input.resolved");
    if (resolution.type !== "input.resolved") throw new Error("Question was not resolved.");
    if (
      !resolution.data.resolutions.some(
        (entry) =>
          entry.kind === "question" &&
          entry.outcome === "answered" &&
          entry.response?.optionId === request.options?.[0]?.id,
      )
    ) {
      throw new Error("The child did not resolve the proxied question with the selected option.");
    }
    await approved.cancel();
    t.noFailedActions();
  },
});

async function waitForInput(t: EveEvalContext, initial: EveEvalSession): Promise<EveEvalSession> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (
      session.pendingInputRequests.some((request) => request.action.toolName === "ask_question")
    ) {
      return session;
    }
    const turn = await watchNextTurn(t, session, "proxied ask wait").result();
    turn.noFailedActions();
    session = turn.session;
  }
  throw new Error("Approval child did not surface its ctx.ask() request.");
}

async function waitForObservedEvent<TType extends "input.resolved">(
  turn: ReturnType<EveEvalContext["target"]["watchTurn"]>,
  type: TType,
) {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    const event = turn.events.find((candidate) => candidate.type === type);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Child did not emit ${type}.`);
}

function watchNextTurn(t: EveEvalContext, session: EveEvalSession, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}
