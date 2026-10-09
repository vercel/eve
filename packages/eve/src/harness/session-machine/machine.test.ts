import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { eachEvent } from "#internal/testing/session-machine.js";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { createSessionContract } from "#internal/testing/session-contract.js";
import {
  createActionsRequestedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  callStatus,
  foldSession,
  initialSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { InputRequest } from "#shared/input.js";
import { createSessionLimitContinuationRequest } from "#harness/hitl/budget-request.js";
import {
  answer,
  grantedApprovalKeys,
  parkOnApprovals as parkOnApprovalsTransition,
  requestLimit,
  requireSignIn,
  type ResponsePolicyPass,
} from "#harness/hitl/approvals.js";
import { deliver, resolveTypedApproval } from "#harness/hitl/delivery.js";
import { applyTransition, sessionView, type Transition } from "./commit.js";
import { saveProjection } from "./current.js";
import {
  cancel,
  clear,
  completeSignIn,
  hold,
  receive,
  relay,
  settle,
  suspendStep,
  startStep,
  type SettledCall,
} from "./transitions.js";
import { storedProjection, suspendedSteps, turnPosition } from "./view.js";

// The session machine's lifecycles, transition by transition. Each test publishes what the
// transitions return, folds it into the projection as the publish sink does, and checks the
// stream against what every reader relies on.

function createMachine() {
  let session: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "test", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test",
    history: [],
    sessionId: "session-test",
  };
  let projection: SessionProjection = initialSessionProjection();
  const contract = createSessionContract();
  const events: UnstampedMessageStreamEvent[] = [];
  const publish = async (event: UnstampedMessageStreamEvent) => {
    events.push(event);
    expect(contract.observe(event)).toEqual([]);
    projection = foldSession(projection, event);
  };
  return {
    get events() {
      return events.map((event) => event.type);
    },
    get projection() {
      return projection;
    },
    get session() {
      return session;
    },
    view: () => sessionView(projection, session.state),
    position: () => turnPosition(projection),
    async apply<T extends Transition>(transition: T): Promise<T> {
      session = await applyTransition(session, transition, eachEvent(publish));
      return transition;
    },
    /** What the model step streams as it runs: its calls. */
    async stream(event: UnstampedMessageStreamEvent) {
      await publish(event);
    },
    eventsSince(count: number) {
      return events.slice(count);
    },
  };
}

type Machine = ReturnType<typeof createMachine>;

function approval(callId: string, toolName = "deploy"): InputRequest {
  return {
    action: { callId, input: { service: "api" }, kind: "tool-call", toolName },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Approve tool call: ${toolName}`,
    requestId: `approval-${callId}`,
  };
}

function callMessage(...callIds: string[]): ModelMessage {
  return {
    content: callIds.flatMap((callId) => [
      {
        input: { service: "api" },
        toolCallId: callId,
        toolName: "deploy",
        type: "tool-call" as const,
      },
    ]),
    role: "assistant",
  };
}

function result(callId: string, value = "ok"): SettledCall {
  return {
    part: {
      output: { type: "text", value },
      toolCallId: callId,
      toolName: "deploy",
      type: "tool-result",
    },
  };
}

const noPolicy = (stepInput?: StepInput): ResponsePolicyPass => ({
  audit: { activeCandidates: [], candidateHistory: [], settlements: [] },
  challenges: [],
  challengesAtStart: [],
  feedback: [],
  kind: "continue",
  stepInput,
});

/** Answers through `deliver` and `answer`, as the tool loop does with no response policy. */
async function respond(machine: Machine, input: StepInput) {
  const delivered = deliver(machine.view(), input, { takeQueued: true });
  // The intake answers a typed approval before the policy pass, as a press.
  const typed = resolveTypedApproval(machine.view(), delivered.input);
  return machine.apply(
    answer(machine.view(), {
      approvalKey: () => undefined,
      delivery: typed,
      policy: noPolicy(typed),
      searchable: () => false,
      takeQueued: delivered.takeQueued,
    }),
  );
}

/** A turn whose model step called `callIds`, each needing approval. */
async function parkOnApprovals(machine: Machine, ...callIds: string[]) {
  await machine.apply(receive(machine.view(), { message: "Deploy the API." }));
  await machine.apply(startStep(machine.view(), { modelId: "test-model" }));
  const position = machine.position();
  await machine.stream(
    createActionsRequestedEvent({
      actions: callIds.map((callId) => ({
        callId,
        input: { service: "api" },
        kind: "tool-call",
        toolName: "deploy",
      })),
      sequence: position.sequence,
      stepIndex: position.stepIndex,
      turnId: position.turnId,
    }),
  );
  const parked = await machine.apply(
    park(machine.view(), {
      event: {
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      },
      messages: [callMessage(...callIds)],
      requests: callIds.map((callId) => approval(callId)),
      tasks: [],
    }),
  );
  // The seam holds the turn for the answers.
  await machine.apply(hold(machine.view(), { on: "input" }));
  return parked;
}

describe("session machine", () => {
  it("parks a step on its approvals, holds the turn, and resumes it when the call runs", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");

    expect(machine.events).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "input.requested",
      "turn.waiting",
    ]);
    expect(machine.projection.activeTurnId).toBe("turn_0");
    expect(callStatus(machine.projection, "call-1")).toBe("awaiting-input");
    // The response waits outside history until its calls have results.
    expect(suspendedSteps(machine.session.state)).toHaveLength(1);
    expect(machine.session.history.map((message) => message.content)).toEqual([
      expect.stringContaining("[Pending approvals]"),
    ]);

    const before = machine.events.length;
    const decision = await respond(machine, {
      inputResponses: [{ optionId: "approve", requestId: "approval-call-1" }],
    });
    expect(decision.next).toBe("continue");
    expect(machine.eventsSince(before)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          resolutions: [expect.objectContaining({ outcome: "approved" })],
          turnId: "turn_0",
        }),
        type: "input.resolved",
      }),
    ]);

    // The answer resumes the held turn.
    await machine.apply(receive(machine.view(), {}));
    expect(machine.eventsSince(before)).toHaveLength(1);

    // eve ran the approved call: its result completes the step, which commits to history.
    await machine.apply(settle(machine.view(), { results: [result("call-1", "deployed")] }));
    expect(suspendedSteps(machine.session.state)).toEqual([]);
    expect(machine.session.history.at(-1)).toMatchObject({
      content: [{ output: { value: "deployed" }, toolCallId: "call-1", type: "tool-result" }],
      role: "tool",
    });
  });

  it("settles a denied call rejected and commits its step without running it", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");

    await respond(machine, {
      inputResponses: [{ optionId: "cancel", requestId: "approval-call-1" }],
    });
    expect(callStatus(machine.projection, "call-1")).toBe("rejected");

    await machine.apply(settle(machine.view(), { results: [] }));
    expect(suspendedSteps(machine.session.state)).toEqual([]);
    expect(machine.session.history.at(-1)).toMatchObject({
      content: [{ output: { type: "execution-denied" }, toolCallId: "call-1" }],
      role: "tool",
    });
  });

  it("holds a partial answer until the rest of its batch arrives", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1", "call-2");

    const before = machine.events.length;
    const partial = await respond(machine, {
      inputResponses: [{ optionId: "approve", requestId: "approval-call-1" }],
    });
    expect(partial.next).toBe("park");
    expect(machine.eventsSince(before)).toEqual([]);
    expect(machine.view().turn.queued?.inputResponses).toHaveLength(1);

    const complete = await respond(machine, {
      inputResponses: [{ optionId: "cancel", requestId: "approval-call-2" }],
    });
    expect(complete.resolved).toHaveLength(1);
    expect(complete.resolved[0]?.inputs.map((input) => input.outcome)).toEqual([
      "approved",
      "denied",
    ]);
    expect(machine.view().turn.queued).toBeUndefined();
  });

  it("steers the held turn past its approvals when a message arrives", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");

    const decision = await respond(machine, { message: "Actually, what time is it?" });
    expect(decision.next).toBe("continue");
    expect(decision.input?.message).toBe("Actually, what time is it?");
    expect(decision.resolved[0]?.inputs.map((input) => input.outcome)).toEqual(["ignored"]);
    expect(callStatus(machine.projection, "call-1")).toBe("rejected");
    await machine.apply(receive(machine.view(), { message: "Actually, what time is it?" }));

    expect(machine.projection.activeTurnId).toBe("turn_0");
    await machine.apply(settle(machine.view(), { results: [] }));
    expect(suspendedSteps(machine.session.state)).toEqual([]);
  });

  it("keeps a workflow call's result with its step until the sibling approval is decided", async () => {
    const machine = createMachine();
    await machine.apply(receive(machine.view(), { message: "Deploy and notify." }));
    await machine.apply(startStep(machine.view(), { modelId: "test-model" }));
    const position = machine.position();
    const event = {
      sequence: position.sequence,
      stepIndex: position.stepIndex,
      turnId: position.turnId,
    };
    await machine.apply(
      park(machine.view(), {
        event,
        messages: [
          {
            content: [
              ...(callMessage("call-1").content as unknown[] as never[]),
              { input: {}, toolCallId: "call-2", toolName: "notify", type: "tool-call" },
            ],
            role: "assistant",
          },
        ],
        requests: [approval("call-1")],
        tasks: [
          {
            callId: "call-2",
            entry: { entryPoint: "execute" },
            input: {},
            kind: "workflow-task",
            toolName: "notify",
            workflowId: "notify",
          },
        ],
      }),
    );
    // The runtime still runs a call, so the turn stays open.
    expect(machine.projection.activeTurnId).toBe("turn_0");

    await machine.apply(
      settle(machine.view(), {
        results: [
          {
            part: {
              output: { type: "text", value: "sent" },
              toolCallId: "call-2",
              toolName: "notify",
              type: "tool-result",
            },
            result: { callId: "call-2", kind: "tool-result", output: "sent", toolName: "notify" },
          },
        ],
      }),
    );
    expect(suspendedSteps(machine.session.state)).toHaveLength(1);

    // Nothing else can run: the turn holds for the open approval.
    const parked = await respond(machine, {});
    expect(parked.next).toBe("park");
    expect(machine.projection.activeTurnId).toBe("turn_0");

    await respond(machine, {
      inputResponses: [{ optionId: "approve", requestId: "approval-call-1" }],
    });
    await machine.apply(receive(machine.view(), {}));
    await machine.apply(settle(machine.view(), { results: [result("call-1")] }));
    const results = machine.session.history.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
        : [],
    );
    expect(results.sort()).toEqual(["call-1", "call-2"]);
  });

  it("cancels a held turn: withdraws what it asked, stops its calls, and commits its step", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");

    await machine.apply(cancel(machine.view()));

    expect(machine.projection.turns.turn_0?.status).toBe("cancelled");
    expect(machine.projection.inputs["approval-call-1"]).toMatchObject({
      outcome: "cancelled",
      status: "settled",
    });
    expect(callStatus(machine.projection, "call-1")).toBe("cancelled");
    expect(suspendedSteps(machine.session.state)).toEqual([]);
    expect(machine.session.history.at(-1)).toMatchObject({
      content: [{ output: { value: expect.stringContaining("cancelled") }, toolCallId: "call-1" }],
      role: "tool",
    });
  });

  it("clears the context: withdraws every request and empties history", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");

    await machine.apply(clear(machine.view(), { sessionId: "session-test" }));

    expect(machine.projection.inputs["approval-call-1"]?.status).toBe("settled");
    expect(callStatus(machine.projection, "call-1")).toBeUndefined();
    expect(machine.session.history).toEqual([]);
    expect(suspendedSteps(machine.session.state)).toEqual([]);
  });

  it("holds for sign-in without publishing a fabricated call result", async () => {
    const machine = createMachine();
    await machine.apply(receive(machine.view(), { message: "Read my calendar." }));
    await machine.apply(startStep(machine.view(), { modelId: "test-model" }));
    const position = machine.position();
    await machine.stream(
      createActionsRequestedEvent({
        actions: [{ callId: "call-1", input: {}, kind: "tool-call", toolName: "calendar" }],
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      }),
    );
    const challenge: AuthorizationChallenge = {
      attemptId: "attempt-1",
      challenge: { instructions: "Sign in to Google." },
      hookUrl: "https://example.test/callback",
      name: "google",
    };

    await machine.apply(
      requireSignIn(machine.view(), {
        callIdsByName: new Map([["google", ["call-1"]]]),
        challenges: [challenge],
      }),
    );
    expect(machine.eventsSince(0).some((event) => event.type === "action.result")).toBe(false);
    expect(machine.projection.authorizations["attempt-1"]?.status).toBe("required");
    expect(machine.events.at(-1)).toBe("turn.waiting");
    expect(machine.projection.activeTurnId).toBe("turn_0");

    const before = machine.events.length;
    await machine.apply(completeSignIn(machine.view(), { completions: [challenge] }));
    await machine.apply(receive(machine.view(), {}));
    expect(machine.eventsSince(before).map((event) => event.type)).toEqual([
      "authorization.completed",
    ]);
  });

  it("retains a child's request coordinates while holding the parent turn", async () => {
    const machine = createMachine();
    await machine.apply(receive(machine.view(), { message: "Ask the researcher." }));
    await machine.apply(startStep(machine.view(), { modelId: "test-model" }));
    const position = machine.position();
    await machine.stream(
      createActionsRequestedEvent({
        actions: [{ callId: "call-1", input: {}, kind: "tool-call", toolName: "researcher" }],
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      }),
    );

    await machine.apply(
      relay(machine.view(), {
        payload: {
          callId: "call-1",
          childContinuationToken: "child-token",
          childSessionId: "child",
          event: {
            requests: [{ ...approval("child-call"), requestId: "child-question" }],
            sequence: 4,
            stepIndex: 2,
            turnId: "child-turn",
          },
          kind: "subagent-input-request",
          subagentName: "researcher",
        },
      }),
    );

    expect(machine.projection.inputs["child-question"]).toMatchObject({
      callId: "call-1",
      sequence: 4,
      stepIndex: 2,
      turnId: "child-turn",
    });
    expect(machine.projection.turns.turn_0?.waiting).toBe(true);
  });
});

describe("checkpoint", () => {
  it("saves the lifecycle its steps read, without the calls and task outputs readers fold", () => {
    const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
    const report = "x".repeat(100_000);
    const projection = [
      { data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" },
      createActionsRequestedEvent({
        ...at,
        actions: [{ callId: "call_1", input: {}, kind: "tool-call", toolName: "research" }],
      }),
      {
        data: { callId: "call_1", kind: "tool", name: "research", taskId: "t1", turnId: "turn_0" },
        type: "task.started",
      },
      {
        data: {
          callId: "call_1",
          output: report,
          status: "completed",
          taskId: "t1",
          turnId: "turn_0",
        },
        type: "task.settled",
      },
    ].reduce(
      (state, event) => foldSession(state, event as UnstampedMessageStreamEvent),
      initialSessionProjection(),
    );
    expect(callStatus(projection, "call_1")).toBe("completed");

    const saved = storedProjection(
      saveProjection({ state: undefined } as HarnessSession, projection).state,
    );
    expect(saved).toMatchObject({ activeTurnId: "turn_0", calls: {}, tasks: {} });
    expect(JSON.stringify(saved)).not.toContain(report);
  });
});

describe("answers", () => {
  it("takes a plain-text answer for the only pending batch", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");

    const decision = await respond(machine, { message: "Approve" });

    expect(decision.consumedMessage).toBe(true);
    expect(decision.input?.message).toBeUndefined();
    expect(decision.resolved[0]?.inputs[0]?.outcome).toBe("approved");
  });

  it("grants a once() approval's key, except to a call still asking for it", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");
    await machine.apply(
      answer(machine.view(), {
        approvalKey: (request) => `deploy:${String(request.action.input.service)}`,
        delivery: { inputResponses: [{ optionId: "approve", requestId: "approval-call-1" }] },
        policy: noPolicy(),
        searchable: () => false,
        takeQueued: false,
      }),
    );
    const key = (request: InputRequest) => `deploy:${String(request.action.input.service)}`;
    expect(grantedApprovalKeys(machine.view(), key)).toEqual(new Set(["deploy:api"]));

    await machine.apply(settle(machine.view(), { results: [result("call-1")] }));
    await parkOnApprovals(machine, "call-2");
    expect(grantedApprovalKeys(machine.view(), key)).toEqual(new Set());
  });

  it("turns an answer to a closed request into text, which authorizes nothing", async () => {
    const machine = createMachine();
    await parkOnApprovals(machine, "call-1");
    await respond(machine, {
      inputResponses: [{ optionId: "cancel", requestId: "approval-call-1" }],
    });

    const delivered = deliver(
      machine.view(),
      { inputResponses: [{ optionId: "approve", requestId: "approval-call-1" }] },
      { takeQueued: true },
    );

    expect(delivered.input?.inputResponses).toBeUndefined();
    expect(delivered.input?.message).toEqual(expect.stringContaining("does not authorize"));
    expect(delivered.displayMessage).toBe("Approve");
  });

  describe("the session-limit prompt", () => {
    const request = createSessionLimitContinuationRequest({
      sessionId: "session-test",
      turnSequence: 1,
      violation: { kind: "input", limit: 100, usedTokens: 101 },
    });

    async function exhausted() {
      const machine = createMachine();
      await machine.apply(receive(machine.view(), { message: "Summarize Alice's notes." }));
      await machine.apply(requestLimit(machine.view(), { request }));
      return machine;
    }

    it("asks whether to continue and ends the turn", async () => {
      const machine = await exhausted();

      expect(machine.events.slice(-3)).toEqual([
        "input.requested",
        "turn.completed",
        "session.waiting",
      ]);
      expect(machine.projection.inputs[request.requestId]?.status).toBe("open");
    });

    it("grants a fresh budget on continue and declines on stop", async () => {
      for (const [optionId, granted] of [
        ["continue", true],
        ["stop", false],
      ] as const) {
        const machine = await exhausted();
        const decision = await respond(machine, {
          inputResponses: [{ optionId, requestId: request.requestId }],
        });
        expect(decision.limit).toEqual({ granted });
        expect(machine.projection.inputs[request.requestId]?.status).toBe("settled");
      }
    });

    it("receives a message now, and queues only what waits for the answer", async () => {
      const machine = await exhausted();

      const decision = await respond(machine, { message: "Any update?" });

      expect(decision.next).toBe("defer-message");
      expect(decision.input?.message).toBe("Any update?");
      expect(machine.view().turn.queued).toBeUndefined();
    });

    it("takes the prompt's answer from text while an approval is also open", async () => {
      const machine = createMachine();
      await parkOnApprovals(machine, "call-1");
      await machine.apply(receive(machine.view(), { message: "Keep going." }));
      await machine.apply(requestLimit(machine.view(), { request }));

      const decision = await respond(machine, { message: "Continue" });

      expect(decision.limit).toEqual({ granted: true });
      expect(callStatus(machine.projection, "call-1")).toBe("awaiting-input");
    });
  });
});

describe("receive", () => {
  it("starts the session and the turn under one trace context, then receives the message", async () => {
    const machine = createMachine();
    const trace = {
      spanId: "0123456789abcdef",
      traceFlags: 1,
      traceId: "0123456789abcdef0123456789abcdef",
    };

    await machine.apply(receive(machine.view(), { message: "hello", trace }));

    expect(machine.eventsSince(0)).toEqual([
      { data: { trace }, type: "session.started" },
      {
        data: { sequence: 0, trace, turnId: "turn_0" },
        type: "turn.started",
      },
      expect.objectContaining({
        data: expect.objectContaining({ turnId: "turn_0" }),
        type: "message.received",
      }),
    ]);
  });

  it("gives hooks the turn's history from turn.started, never before the session started", async () => {
    const seen: [string, readonly ModelMessage[] | undefined][] = [];
    const history: ModelMessage[] = [{ content: "hello", role: "user" }];
    const machine = createMachine();
    await applyTransition(
      machine.session,
      receive(machine.view(), { message: "hello" }),
      eachEvent(async (event, messages) => {
        seen.push([event.type, messages]);
      }),
      history,
    );

    expect(seen).toEqual([
      ["session.started", undefined],
      ["turn.started", history],
      ["message.received", undefined],
    ]);
  });

  it("joins the open turn when steering arrives", async () => {
    const machine = createMachine();
    await machine.apply(receive(machine.view(), { message: "Start the work" }));
    const before = machine.events.length;

    await machine.apply(receive(machine.view(), { message: "Use the staging data." }));

    expect(machine.events.slice(before)).toEqual(["message.received"]);
  });
});

function park(
  view: Parameters<typeof parkOnApprovalsTransition>[0],
  input: Parameters<typeof parkOnApprovalsTransition>[1],
): Transition {
  return input.requests.length === 0
    ? suspendStep(view, input)
    : parkOnApprovalsTransition(view, input);
}
