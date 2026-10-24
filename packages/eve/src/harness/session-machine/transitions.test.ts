import { describe, expect, it } from "vitest";

import { requireSignIn } from "#harness/hitl/approvals.js";
import { settleLimit } from "#harness/hitl/budget.js";
import { cascade } from "#harness/session-machine/cascade.js";
import { dropClosedRecords, saveTransition, sessionView } from "#harness/session-machine/commit.js";
import { readHitlState } from "#harness/hitl/requests.js";
import {
  awaitSignIns,
  callSignInsSettled,
  CANCELLED_CALL_RESULT,
  cancel,
  clear,
  completeSignIn,
  controlled,
  discardAttempt,
  fail,
  matchSignIns,
  relay,
  routeAnswer,
  runnableCalls,
  settle,
} from "#harness/session-machine/transitions.js";
import { sessionEndedFacts } from "#harness/facts.js";
import type { SuspendedStep } from "#harness/session-machine/state.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { withOpenTurn, withPublished, withQueuedInput } from "#internal/testing/session-machine.js";

const BASE: HarnessSession = {
  agent: { modelReference: { id: "test" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 0.8 },
  continuationToken: "test",
  history: [],
  sessionId: "session-1",
};
const turnId = "turn_0";
const runId = `test_${turnId}_0`;

function viewOf(session: HarnessSession) {
  return sessionView(storedProjection(session.state), session.state);
}

/** A turn whose run called `probe`, which started and is still running. */
function runningCall(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: { callId: "probe", capability: { kind: "tool", name: "auth-probe" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    { data: { callId: "probe" }, scope: { turnId }, type: "call.started" },
  ]);
}

describe("the budget prompt", () => {
  it("refuses an answer that is neither Continue nor Stop, and keeps asking", () => {
    const interactionId = "budget-1";
    const asked = withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
      {
        data: {
          interactionId,
          request: {
            kind: "budget",
            options: [{ id: "continue", label: "Continue" }],
            prompt: "?",
          },
          subject: { turnId },
        },
        scope: { turnId },
        type: "interaction.opened",
      },
    ]);
    // The answer stands, admitted, as any answer to the prompt does.
    const answered = withPublished(asked, [
      {
        data: { deliveryId: "d_1", interactionId, responseId: "r_1", value: { optionId: "maybe" } },
        type: "response.submitted",
      },
      { data: { responseId: "r_1" }, type: "response.admitted" },
    ]);
    const settled = settleLimit(viewOf(answered));

    expect(settled.limit).toBeUndefined();
    expect(settled.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ outcome: "refused", responseId: "r_1" }),
        type: "response.settled",
      }),
    ]);
  });
});

describe("requireSignIn", () => {
  it("keeps the call a sign-in stopped open in its step, to run once the sign-in calls back", () => {
    const session = runningCall();
    const base = viewOf(session);
    const view = {
      ...base,
      turn: {
        ...base.turn,
        suspended: [
          {
            event: { sequence: 0, stepIndex: 0, turnId },
            messages: [
              {
                content: [
                  {
                    input: {},
                    toolCallId: "probe",
                    toolName: "auth-probe",
                    type: "tool-call" as const,
                  },
                ],
                role: "assistant" as const,
              },
            ],
            requests: [],
            tasks: [],
          },
        ],
      },
    };
    const challenge = {
      attemptId: "attempt-1",
      challenge: { url: "https://example.test/sign-in" },
      hookUrl: "https://example.test/callback",
      name: "auth-probe",
    };
    const { events, turn } = requireSignIn(view, {
      calls: [
        {
          call: { callId: "probe", input: {}, toolName: "auth-probe" },
          connections: ["auth-probe"],
        },
      ],
      challenges: [challenge],
    });

    // The step pauses the turn once nothing it holds can run; the transition only asks. The call
    // doesn't settle: its sign-in's outcome settles with it once it runs.
    expect(events.map((event) => event.type)).toEqual(["interaction.opened"]);
    expect(turn.suspended[0]?.approved).toEqual([
      { call: { callId: "probe", input: {}, toolName: "auth-probe" }, signIns: [challenge] },
    ]);
    expect(accepted(session, events)).toEqual([]);
  });
});

describe("sessionEndedFacts", () => {
  it("starts a session that ends before it started, so the end has something to end", () => {
    const facts = sessionEndedFacts(initialSessionProjection(), { outcome: "failed" });
    expect(facts.map((event) => event.type)).toEqual(["session.started", "session.ended"]);
  });

  it("doesn't start a session twice", () => {
    const projection = storedProjection(runningCall().state);
    const facts = sessionEndedFacts(projection, { outcome: "completed" });
    expect(facts.filter((event) => event.type === "session.started")).toEqual([]);
  });
});

/** A turn whose run called a tool and started an agent task, then asked a person to approve. */
function busyTurn(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: { callId: "tool", capability: { kind: "tool", name: "lookup" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    { data: { callId: "tool" }, scope: { turnId }, type: "call.started" },
    {
      data: { callId: "agent", capability: { kind: "agent", name: "helper" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    {
      data: { kind: "agent", name: "helper", startedBy: { callId: "agent" }, taskId: "task-1" },
      scope: { turnId },
      type: "task.started",
    },
    { data: { callId: "agent", taskId: "task-1" }, scope: { turnId }, type: "call.started" },
    {
      data: {
        interactionId: "approval-1",
        request: { kind: "approval", prompt: "Approve?" },
        subject: { callId: "tool" },
      },
      scope: { turnId },
      type: "interaction.opened",
    },
  ]);
}

/** What `events` settles, by type and id. */
function settledBy(events: readonly SessionEvent[]): Record<string, string> {
  const settled: Record<string, string> = {};
  for (const event of events) {
    if (!("outcome" in event.data)) continue;
    const id = Object.entries(event.data).find(([key]) => key.endsWith("Id"))?.[1];
    settled[`${event.type}:${String(id ?? "")}`] = String(event.data.outcome);
  }
  return settled;
}

describe("closing what a turn leaves open", () => {
  it("fails the turn with its run and calls, keeping the task that outlives it", () => {
    const events = committed(viewOf(busyTurn()), (view) =>
      fail(view, { code: "BOOM", message: "It broke." }),
    );

    // The failing model run keeps the error; its unfinished calls are interrupted.
    expect(settledBy(events)).toMatchObject({
      "call.settled:tool": "interrupted",
      "interaction.settled:approval-1": "interrupted",
      "model.settled:test_turn_0_0": "failed",
      "turn.settled:turn_0": "failed",
    });
    expect(events.some((event) => event.type === "task.ended")).toBe(false);
    for (const type of ["model.settled", "turn.settled"]) {
      expect(events.find((event) => event.type === type)).toMatchObject({
        data: { error: { code: "BOOM", message: "It broke." } },
      });
    }
  });

  it("cancels the turn, interrupting what it asked and stopping its work", () => {
    const events = committed(viewOf(busyTurn()), (view) =>
      cancel(view, { cause: { deliveryId: "cancel-1" } }),
    );

    expect(settledBy(events)).toMatchObject({
      "call.settled:tool": "interrupted",
      "interaction.settled:approval-1": "interrupted",
      "turn.settled:turn_0": "cancelled",
    });
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { cause: { deliveryId: "cancel-1" } },
    });
  });

  it("abandons a retried attempt's run and calls, and interrupts a steered one's", () => {
    const retried = committed(viewOf(busyTurn()), (view) =>
      discardAttempt(view, { ending: "retried", runId }),
    );
    expect(settledBy(retried)).toMatchObject({
      "call.settled:tool": "abandoned",
      "model.settled:test_turn_0_0": "abandoned",
    });

    const steered = committed(viewOf(busyTurn()), (view) =>
      discardAttempt(view, { ending: "steered", runId }),
    );
    expect(settledBy(steered)).toMatchObject({
      "call.settled:tool": "interrupted",
      "model.settled:test_turn_0_0": "completed",
    });
  });

  it("ends the session with everything it left open, the task too; its turn didn't fail", () => {
    const projection = storedProjection(busyTurn().state);
    const facts = cascade(projection.view, sessionEndedFacts(projection, { outcome: "failed" }));

    expect(settledBy(facts)).toMatchObject({
      "session.ended:": "failed",
      "task.ended:task-1": "cancelled",
      "turn.settled:turn_0": "cancelled",
    });
    expect(facts.at(-1)?.type).toBe("session.ended");
  });

  it("commits each closure as one line the contract accepts", () => {
    const session = busyTurn();
    const seed = storedProjection(session.state).view;
    for (const events of [
      committed(viewOf(session), (view) => fail(view, { code: "BOOM", message: "It broke." })),
      committed(viewOf(session), (view) => cancel(view)),
      cascade(seed, sessionEndedFacts(storedProjection(session.state), { outcome: "completed" })),
    ]) {
      const checker = createStreamChecker({ seed });
      expect(
        checker.check({ at: "2026-10-09T00:00:00.000Z", facts: events }, seed!.position),
      ).toEqual([]);
    }
  });
});

/** The callback that completes the GitHub sign-in. */
const GITHUB_CALLBACK = {
  attemptId: "github-1",
  challenge: {},
  hookUrl: "https://example.test/cb",
  name: "github",
};

/** A paused turn waiting on `approval-1` about its call, and on a GitHub sign-in. */
function waitingTurn(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: { callId: "tool", capability: { kind: "tool", name: "deploy" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    {
      data: {
        interactionId: "approval-1",
        request: { kind: "approval", prompt: "Approve deploy?" },
        subject: { callId: "tool" },
      },
      scope: { turnId },
      type: "interaction.opened",
    },
    {
      data: {
        interactionId: "github-1",
        request: {
          kind: "sign-in",
          prompt: "Sign in to GitHub",
          signIn: { callbackUrl: "https://example.test/cb", name: "github" },
        },
        subject: { turnId },
      },
      scope: { turnId },
      type: "interaction.opened",
    },
  ]);
}

/** Whether the contract accepts `events` as the next line after `session`'s. */
function accepted(session: HarnessSession, events: readonly SessionEvent[]) {
  const seed = storedProjection(session.state).view;
  return createStreamChecker({ seed }).check(
    { at: "2026-10-10T00:00:00.000Z", facts: events },
    seed!.position,
  );
}

describe("controls and callbacks as deliveries", () => {
  it("admits a cancel, ends the turn naming it, and applies it, in one commit", () => {
    const session = waitingTurn();
    const delivery = { deliveryId: "cancel-1", principal: { id: "alice", type: "user" } };
    const events = committed(viewOf(session), (view) =>
      controlled(delivery, "cancel", (cause) => cancel(view, { cause })),
    );

    expect(events[0]).toEqual({
      data: {
        deliveryId: "cancel-1",
        principal: delivery.principal,
        source: { control: "cancel" },
      },
      type: "delivery.admitted",
    });
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { cause: { deliveryId: "cancel-1" }, outcome: "cancelled" },
    });
    expect(events.at(-1)).toEqual({
      data: { deliveryId: "cancel-1", outcome: "applied" },
      type: "delivery.settled",
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it("clears by closing the turn and withdrawing its requests before an empty selection", () => {
    const session = waitingTurn();
    const transition = clear(viewOf(session), { cause: { deliveryId: "clear-1" } });
    const events = cascade(viewOf(session).projection.view, transition.events);
    const saved = saveTransition(withPublished(session, events), transition);
    const cleared = dropClosedRecords(saved, storedProjection(saved.state));
    expect(readHitlState(cleared.state).signIns).toEqual([]);
    expect(readHitlState(cleared.state).responders).toEqual({});

    expect(settledBy(events)).toMatchObject({
      "interaction.settled:approval-1": "interrupted",
      "interaction.settled:github-1": "interrupted",
      "turn.settled:turn_0": "cancelled",
    });
    expect(events.at(-1)).toMatchObject({
      data: { kind: "clear", outcome: "completed", selects: null },
      type: "context.settled",
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it.each(["cancel", "clear"] as const)(
    "%s settles input the turn queued but never read as ignored",
    (control) => {
      const admitted = withPublished(waitingTurn(), [
        { data: { deliveryId: "d-typed" }, type: "delivery.admitted" },
        { data: { deliveryId: "d-kept" }, type: "delivery.admitted" },
        { data: { deliveryId: "d-kept", parts: [], turnId }, type: "delivery.consumed" },
      ]);
      const queued = withQueuedInput(admitted, {
        deliveries: [
          { deliveryId: "d-typed", parts: [] },
          { deliveryId: "d-kept", parts: [] },
        ],
        message: "approve",
      });
      const view = viewOf(queued);
      const transition = control === "cancel" ? cancel(view) : clear(view);
      const events = cascade(view.projection.view, transition.events);

      expect(settledBy(events)).toMatchObject({
        "delivery.settled:d-typed": "ignored",
        "delivery.settled:d-kept": "handled",
      });
      expect(transition.turn).not.toHaveProperty("queued");
      expect(accepted(queued, events)).toEqual([]);
    },
  );

  it("completes a sign-in from its callback without recording the provider's payload", () => {
    const session = waitingTurn();
    const { events } = completeSignIn(viewOf(session), {
      completions: [GITHUB_CALLBACK],
    });

    expect(events.map((event) => event.type)).toEqual([
      "delivery.admitted",
      "response.submitted",
      "response.settled",
      "interaction.settled",
      "delivery.settled",
    ]);
    expect(events[1]?.data).toEqual({
      deliveryId: "callback_github-1",
      interactionId: "github-1",
      responseId: "response_callback_github-1",
    });
    expect(events[3]).toMatchObject({
      data: { cause: { responseId: "response_callback_github-1" }, outcome: "accepted" },
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it("ignores a callback for a sign-in that already ended", () => {
    const { events } = completeSignIn(viewOf(BASE), {
      completions: [GITHUB_CALLBACK],
    });
    expect(events).toEqual([]);
  });
});

/** A sign-in for `name`, as its attempt asks for it and its callback completes it. */
function signIn(name: string): AuthorizationChallenge {
  return { attemptId: `${name}-1`, challenge: {}, hookUrl: `https://example.test/${name}`, name };
}

/** A call to `deploy` that the model made, with what a sign-in for `connection` stopped. */
function stoppedCall(callId: string, connection: string) {
  return {
    call: { callId, input: { service: "api" }, toolName: "deploy" },
    connections: [connection],
  };
}

/**
 * A paused turn whose run made `callIds`, each started and then stopped on a sign-in for the
 * matching connection in `connections`, which the session still waits on.
 */
function stoppedOnSignIns(callIds: readonly string[], connections: readonly string[]) {
  const session = withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    ...callIds.flatMap((callId): SessionEvent[] => [
      {
        data: { callId, capability: { kind: "tool", name: "deploy" }, owner: { runId } },
        scope: { runId, turnId },
        type: "call.requested",
      },
      { data: { callId }, scope: { turnId }, type: "call.started" },
    ]),
    ...connections.map((name): SessionEvent => ({
      data: {
        interactionId: `${name}-1`,
        request: { kind: "sign-in", prompt: `Sign in to ${name}`, signIn: { name } },
        subject: { turnId },
      },
      scope: { turnId },
      type: "interaction.opened",
    })),
  ]);
  const step = awaitSignIns(
    {
      event: { sequence: 0, stepIndex: 0, turnId },
      messages: [
        {
          content: callIds.map((callId) => ({
            input: { service: "api" },
            toolCallId: callId,
            toolName: "deploy",
            type: "tool-call" as const,
          })),
          role: "assistant",
        },
      ],
      requests: [],
      tasks: [],
    },
    {
      challenges: connections.map(signIn),
      stopped: callIds.map((callId, index) => stoppedCall(callId, connections[index]!)),
    },
  );
  const base = viewOf(session);
  const view: SessionView = {
    ...base,
    signIns: connections.map(signIn),
    turn: { ...base.turn, suspended: [step] },
  };
  return { session, step, view };
}

describe("settle", () => {
  it("settles and counts the spend only of a call the view still records", () => {
    const base = viewOf(runningCall());
    const results = ["probe", "pruned"].map((callId) => ({
      part: {
        output: { type: "text" as const, value: "done" },
        toolCallId: callId,
        toolName: "auth-probe",
        type: "tool-result" as const,
      },
      result: { callId, kind: "tool-result" as const, output: "done", toolName: "auth-probe" },
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 5, outputTokens: 1 },
    }));
    const view = {
      ...base,
      turn: {
        ...base.turn,
        suspended: [
          {
            event: { sequence: 0, stepIndex: 0, turnId },
            messages: [
              {
                content: results.map(({ part }) => ({
                  input: {},
                  toolCallId: part.toolCallId,
                  toolName: "auth-probe",
                  type: "tool-call" as const,
                })),
                role: "assistant" as const,
              },
            ],
            requests: [],
            tasks: [],
          },
        ],
      },
    };

    const { commit, events } = settle(view, { results });

    // Both results reach the model; only the recorded call settles and owns what it spent.
    expect(commit.at(-1)?.content).toHaveLength(2);
    expect(events).toMatchObject([
      { data: { callId: "probe" }, type: "call.settled" },
      { data: { owner: { callId: "probe" } }, type: "usage.recorded" },
    ]);
  });
});

describe("calls a sign-in stopped", () => {
  it("runs each call once its own sign-ins call back, and the call reports them, not the callback", () => {
    const { session, step, view } = stoppedOnSignIns(["call-1", "call-2"], ["google", "slack"]);
    const runnable = (at: SessionView) => runnableCalls(at, step).map(({ call }) => call.callId);
    expect(step.approved?.map(({ call }) => call.callId)).toEqual(["call-1", "call-2"]);
    expect(runnable(view)).toEqual([]);

    // Google calls back: its call can run, and the callback itself records nothing.
    const matched: SessionView = {
      ...view,
      signIns: matchSignIns(view, { attemptIds: ["google-1"] }).signIns!,
    };
    expect(completeSignIn(matched, { completions: [signIn("google")] }).events).toEqual([]);
    expect(runnable(matched)).toEqual(["call-1"]);

    // The call returned: its sign-in is accepted, in a line the contract accepts.
    const [first, second] = step.approved!;
    const accepted_ = callSignInsSettled(matched, first!);
    expect(accepted_.map((event) => event.type)).toEqual([
      "delivery.admitted",
      "response.submitted",
      "response.settled",
      "interaction.settled",
      "delivery.settled",
    ]);
    expect(settledBy(accepted_)).toMatchObject({ "interaction.settled:google-1": "accepted" });
    expect(accepted(session, accepted_)).toEqual([]);

    // A call that throws fails its sign-in with why, and says when the failure is terminal.
    const failed = callSignInsSettled(matched, second!, {
      reason: "access_denied",
      retryable: false,
    });
    expect(failed.find((event) => event.type === "interaction.settled")?.data).toEqual({
      cause: { responseId: "response_callback_slack-1" },
      interactionId: "slack-1",
      outcome: "failed",
      reason: "access_denied",
      response: { retryable: false },
    });
    expect(accepted(session, failed)).toEqual([]);
  });

  it("keeps the approval of an approved call that a sign-in stops again", () => {
    const stopped = stoppedCall("call-1", "google");
    const step: SuspendedStep = {
      approved: [{ call: stopped.call, interactionId: "approval-1" }],
      event: { sequence: 0, stepIndex: 0, turnId },
      messages: [
        {
          content: [{ input: {}, toolCallId: "call-1", toolName: "deploy", type: "tool-call" }],
          role: "assistant",
        },
      ],
      requests: [],
      tasks: [],
    };
    const next = awaitSignIns(step, { challenges: [signIn("google")], stopped: [stopped] });
    expect(next.approved).toEqual([
      { call: stopped.call, interactionId: "approval-1", signIns: [signIn("google")] },
    ]);
  });

  it("cancels the call a sign-in stopped with its turn, answering it as cancelled", () => {
    const { view } = stoppedOnSignIns(["call-1"], ["google"]);
    const transition = cancel(view);

    expect(settledBy(committed(view, () => transition))).toMatchObject({
      "call.settled:call-1": "interrupted",
      "interaction.settled:google-1": "interrupted",
      "turn.settled:turn_0": "cancelled",
    });
    expect(transition.turn.suspended).toEqual([]);
    expect(JSON.stringify(transition.commit)).toContain(CANCELLED_CALL_RESULT);
  });
});

describe("routing answers", () => {
  it("ignores a child settlement for a local request or another call's mirror", () => {
    const parent = runningCall();
    const mirror = withPublished(
      parent,
      relay(viewOf(parent), {
        payload: {
          kind: "subagent-interaction",
          callId: "probe",
          childSessionId: "child-1",
          subagentName: "deployer",
          events: [
            {
              type: "interaction.opened",
              data: {
                interactionId: "remote",
                request: { kind: "question", prompt: "Continue?" },
                subject: { turnId: "child-turn" },
              },
            },
          ],
        },
      }).events,
    );
    for (const [session, interactionId, callId] of [
      [waitingTurn(), "approval-1", "tool"],
      [mirror, "remote", "another-call"],
    ] as const) {
      const ending = relay(viewOf(session), {
        payload: {
          kind: "subagent-interaction",
          callId,
          childSessionId: "child-1",
          subagentName: "deployer",
          events: [{ type: "interaction.settled", data: { interactionId, outcome: "accepted" } }],
        },
      });
      expect(ending.events).toEqual([]);
    }
  });

  it.each([false, true])("takes a forwarded answer once (previously admitted: %s)", (admitted) => {
    const session = admitted
      ? withPublished(waitingTurn(), [
          {
            data: { deliveryId: "d-answer" },
            type: "delivery.admitted",
          },
        ])
      : waitingTurn();
    const { events } = routeAnswer(viewOf(session), {
      decided: [],
      deliveries: [{ deliveryId: "d-answer" }],
      forwarded: [
        { deliveryId: "d-answer", interactionId: "approval-1", responseId: "r-1" },
        { deliveryId: "d-answer", interactionId: "gone", responseId: "r-2" },
        { deliveryId: "d-unknown", interactionId: "approval-1", responseId: "r-3" },
      ],
    });

    expect(
      events.filter((event) => event.type === "response.submitted").map((event) => event.data),
    ).toEqual([{ deliveryId: "d-answer", interactionId: "approval-1", responseId: "r-1" }]);
    expect(events.filter((event) => event.type === "delivery.admitted")).toHaveLength(
      admitted ? 0 : 1,
    );
    expect(events).toContainEqual({
      data: { deliveryId: "d-answer", outcome: "applied" },
      type: "delivery.settled",
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it("admits a forwarded answer once the asker admits it, while its batch waits", () => {
    const parent = runningCall();
    const mirrored = withPublished(
      parent,
      relay(viewOf(parent), {
        payload: {
          callId: "probe",
          childSessionId: "child-1",
          kind: "subagent-interaction",
          subagentName: "deployer",
          events: [
            {
              type: "interaction.opened",
              data: {
                interactionId: "approval-1",
                subject: { turnId: "child-turn" },
                request: { kind: "approval", prompt: "Deploy?" },
              },
            },
          ],
        },
      }).events,
    );
    const forwarded = withPublished(mirrored, [
      { data: { deliveryId: "d-answer" }, type: "delivery.admitted" },
      {
        data: { deliveryId: "d-answer", interactionId: "approval-1", responseId: "r-1" },
        type: "response.submitted",
      },
    ]);
    const admitted = (deliveryId: string) =>
      relay(viewOf(forwarded), {
        payload: {
          callId: "probe",
          childSessionId: "child-1",
          events: [
            { data: { deliveryId, interactionId: "approval-1" }, type: "response.admitted" },
          ],
          kind: "subagent-interaction",
          subagentName: "deployer",
        },
      }).events;

    expect(admitted("d-answer")).toEqual([
      { data: { responseId: "r-1" }, type: "response.admitted" },
    ]);
    expect(accepted(forwarded, admitted("d-answer"))).toEqual([]);
    // An answer already admitted here isn't admitted twice.
    const twice = withPublished(forwarded, admitted("d-answer"));
    expect(
      relay(viewOf(twice), {
        payload: {
          callId: "probe",
          childSessionId: "child-1",
          events: [
            {
              data: { deliveryId: "d-answer", interactionId: "approval-1" },
              type: "response.admitted",
            },
          ],
          kind: "subagent-interaction",
          subagentName: "deployer",
        },
      }).events,
    ).toEqual([]);
  });
});

/** A transition's facts as the session commits them: an owner's end closes what it holds. */
function committed(
  view: ReturnType<typeof viewOf>,
  decide: (view: ReturnType<typeof viewOf>) => { readonly events: readonly SessionEvent[] },
): SessionEvent[] {
  return cascade(view.projection.view, decide(view).events);
}
