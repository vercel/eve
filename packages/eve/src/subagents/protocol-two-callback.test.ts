import { describe, expect, it } from "vitest";

import { sessionView } from "#harness/session-machine/commit.js";
import { relay, routeAnswer } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { withOpenTurn, withPublished } from "#internal/testing/session-machine.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import {
  protocolTwoAnswersSettledOnForward,
  readProtocolTwoInputCallback,
} from "#subagents/protocol-two-callback.js";

const BASE: HarnessSession = {
  agent: { modelReference: { id: "test" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 0.8 },
  continuationToken: "test",
  history: [],
  sessionId: "parent-session",
};
const turnId = "turn_0";
const runId = `test_${turnId}_0`;
const position = { sequence: 4, stepIndex: 1, turnId: "child-turn" };

/** The parent's turn, whose remote call `delegate` is running. */
function delegating(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: {
        callId: "delegate",
        capability: { kind: "agent", name: "deployer" },
        owner: { runId },
      },
      scope: { runId, turnId },
      type: "call.requested",
    },
    { data: { callId: "delegate" }, scope: { turnId }, type: "call.started" },
  ]);
}

function viewOf(session: HarnessSession) {
  return sessionView(storedProjection(session.state), session.state);
}

function mirror(session: HarnessSession, body: unknown): HarnessSession {
  const payload = readProtocolTwoInputCallback(body);
  if (payload === undefined) throw new Error("not a protocol 2 callback");
  return withPublished(session, relay(viewOf(session), { payload }).events);
}

/** What eve 0.83.2 posts when a child's tool needs approval and its model asks a question. */
const inputRequest = {
  callId: "delegate",
  childContinuationToken: "child-hook",
  childSessionId: "child-session",
  inputSource: "session",
  kind: "subagent-input-request",
  subagentName: "deployer",
  event: {
    ...position,
    requests: [
      {
        action: {
          callId: "deploy-call",
          input: { target: "prod" },
          kind: "tool-call",
          toolName: "deploy",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
        prompt: "Deploy to prod?",
        requestId: "approval-1",
      },
      {
        action: {
          callId: "ask-call",
          input: { question: "Which region?" },
          kind: "tool-call",
          toolName: "ask_question",
        },
        allowFreeform: true,
        kind: "question",
        prompt: "Which region?",
        requestId: "question-1",
      },
    ],
  },
};

function authorizationEvent(event: { readonly type: string; readonly data: object }) {
  return {
    callId: "delegate",
    childSessionId: "child-session",
    event,
    kind: "subagent-authorization-event",
    subagentName: "deployer",
  };
}

describe("a protocol 2 child's input requests", () => {
  it("mirror as the requests a v27 child relays, answerable back through the child's route", () => {
    const payload = readProtocolTwoInputCallback(inputRequest);
    expect(payload).toEqual({
      callId: "delegate",
      childSessionId: "child-session",
      events: [
        {
          data: {
            interactionId: "approval-1",
            origin: {
              call: { callId: "deploy-call", input: { target: "prod" }, name: "deploy" },
              interactionId: "approval-1",
              sessionId: "child-session",
            },
            request: {
              display: "confirmation",
              kind: "approval",
              options: [
                { id: "approve", label: "Approve", style: "primary" },
                { id: "deny", label: "Deny", style: "danger" },
              ],
              prompt: "Deploy to prod?",
            },
            subject: { turnId: "child-turn" },
          },
          type: "interaction.opened",
        },
        {
          data: {
            interactionId: "question-1",
            origin: {
              call: {
                callId: "ask-call",
                input: { question: "Which region?" },
                name: "ask_question",
              },
              interactionId: "question-1",
              sessionId: "child-session",
            },
            request: { allowFreeform: true, kind: "question", prompt: "Which region?" },
            subject: { turnId: "child-turn" },
          },
          type: "interaction.opened",
        },
      ],
      kind: "subagent-interaction",
      route: { childContinuationToken: "child-hook", inputSource: "session" },
      subagentName: "deployer",
    } satisfies SubagentInteractionHookPayload);

    const mirrored = mirror(delegating(), inputRequest);
    const tables = storedProjection(mirrored.state).view;
    expect(tables.interactions["approval-1"]).toMatchObject({
      status: "open",
      subject: { callId: "delegate" },
    });
    expect(tables.interactions["question-1"]).toMatchObject({
      status: "open",
      subject: { callId: "delegate" },
    });
    // Answers go back the way the requests came; the parent adds the child's remote binding.
    const route = { childContinuationToken: "child-hook", inputSource: "session" };
    expect(relay(viewOf(delegating()), { payload: payload! }).relays).toEqual({
      "approval-1": route,
      "question-1": route,
    });
  });

  it("asks about no call for a budget prompt", () => {
    const [opened] =
      readProtocolTwoInputCallback({
        ...inputRequest,
        event: {
          ...position,
          requests: [
            {
              action: { callId: "limit", input: {}, kind: "tool-call", toolName: "session-limit" },
              kind: "session-limit",
              options: [
                { id: "continue", label: "Continue" },
                { id: "deny", label: "Stop" },
              ],
              prompt: "Keep going?",
              requestId: "budget-1",
            },
          ],
        },
      })?.events ?? [];
    expect(opened).toMatchObject({
      data: {
        origin: { interactionId: "budget-1", sessionId: "child-session" },
        request: { kind: "budget" },
      },
    });
    expect(opened?.data).not.toHaveProperty("origin.call");
  });

  it("refuses a body that is not a protocol 2 request", () => {
    expect(
      readProtocolTwoInputCallback({ ...inputRequest, event: { ...position, requests: [] } }),
    ).toBeUndefined();
    expect(
      readProtocolTwoInputCallback({ ...inputRequest, childContinuationToken: undefined }),
    ).toBeUndefined();
    expect(readProtocolTwoInputCallback({ ...inputRequest, kind: "task.input-requested" })).toBe(
      undefined,
    );
  });
});

describe("how a protocol 2 child settles what it asked", () => {
  /** The parent mirrored the approval and forwarded `alice`'s answer to the child. */
  function forwarded(): HarnessSession {
    const mirrored = mirror(delegating(), inputRequest);
    return withPublished(
      mirrored,
      routeAnswer(viewOf(mirrored), {
        decided: [],
        deliveries: [{ deliveryId: "d-answer" }],
        forwarded: [
          {
            deliveryId: "d-answer",
            interactionId: "approval-1",
            responseId: "r-1",
            value: { optionId: "approve" },
          },
        ],
      }).events,
    );
  }

  it("admits the answer while the child checks its responder, then settles the approval", () => {
    const candidate = mirror(
      forwarded(),
      authorizationEvent({
        data: {
          ...position,
          candidateId: "candidate-1",
          outcome: "pending",
          requestId: "approval-1",
          responderPrincipalId: "alice",
        },
        type: "approval.candidate",
      }),
    );
    expect(storedProjection(candidate.state).view.responses["r-1"]?.status).toBe("admitted");
    expect(storedProjection(candidate.state).view.interactions["approval-1"]?.status).toBe("open");

    // The approval's own settlement mirrors nothing; the resolution that follows decides it.
    expect(
      readProtocolTwoInputCallback(
        authorizationEvent({
          data: {
            ...position,
            outcome: "approved",
            requestId: "approval-1",
            responderPrincipalId: "alice",
          },
          type: "approval.settled",
        }),
      )?.events,
    ).toEqual([]);

    const resolved = mirror(
      candidate,
      authorizationEvent({
        data: {
          ...position,
          resolutions: [
            {
              kind: "tool-approval",
              outcome: "approved",
              requestId: "approval-1",
              response: { optionId: "approve", requestId: "approval-1" },
            },
          ],
        },
        type: "input.resolved",
      }),
    );
    const tables = storedProjection(resolved.state).view;
    expect(tables.interactions["approval-1"]).toMatchObject({
      outcome: "accepted",
      status: "settled",
    });
    expect(tables.responses["r-1"]).toMatchObject({ outcome: "applied", status: "settled" });
  });

  it("keeps the approval open when the child turns an answer away", () => {
    const rejected = mirror(
      forwarded(),
      authorizationEvent({
        data: {
          ...position,
          candidateId: "candidate-1",
          outcome: "rejected",
          reason: "Only the requester can approve.",
          requestId: "approval-1",
          responderPrincipalId: "mallory",
        },
        type: "approval.candidate",
      }),
    );
    const tables = storedProjection(rejected.state).view;
    expect(tables.responses["r-1"]).toMatchObject({ outcome: "refused", status: "settled" });
    expect(tables.interactions["approval-1"]?.status).toBe("open");
  });

  it("settles a denial and a withdrawal as the child resolved them", () => {
    const settled = mirror(
      mirror(delegating(), inputRequest),
      authorizationEvent({
        data: {
          ...position,
          resolutions: [
            { kind: "tool-approval", outcome: "denied", requestId: "approval-1" },
            { kind: "question", outcome: "cancelled", requestId: "question-1" },
          ],
        },
        type: "input.resolved",
      }),
    );
    const tables = storedProjection(settled.state).view;
    expect(tables.interactions["approval-1"]?.outcome).toBe("declined");
    expect(tables.interactions["question-1"]?.outcome).toBe("withdrawn");
  });

  it("mirrors a sign-in from required to completed, with or without an attempt id", () => {
    for (const attemptId of ["attempt-1", undefined]) {
      const fields = {
        ...position,
        name: "github",
        principalId: "alice",
        ...(attemptId !== undefined && { attemptId }),
      };
      const required = mirror(
        delegating(),
        authorizationEvent({
          data: {
            ...fields,
            authorization: { url: "https://github.example.com/login" },
            description: "Sign in to github to continue.",
          },
          type: "authorization.required",
        }),
      );
      const open = Object.values(storedProjection(required.state).view.interactions);
      expect(open).toEqual([
        expect.objectContaining({
          audience: { principalIds: ["alice"] },
          request: expect.objectContaining({
            kind: "sign-in",
            link: { url: "https://github.example.com/login" },
          }),
          status: "open",
        }),
      ]);
      // Nobody answers a sign-in through the parent: the person signs in at the child.
      const payload = readProtocolTwoInputCallback(
        authorizationEvent({
          data: { ...fields, description: "Sign in to github to continue." },
          type: "authorization.required",
        }),
      );
      expect(relay(viewOf(delegating()), { payload: payload! }).relays).toBeUndefined();

      const completed = mirror(
        required,
        authorizationEvent({
          data: { ...fields, outcome: "authorized" },
          type: "authorization.completed",
        }),
      );
      expect(Object.values(storedProjection(completed.state).view.interactions)).toEqual([
        expect.objectContaining({ outcome: "accepted", status: "settled" }),
      ]);
    }
  });

  it("ignores a fact about a request another call relayed", () => {
    const mirrored = mirror(delegating(), inputRequest);
    const elsewhere = readProtocolTwoInputCallback({
      ...authorizationEvent({
        data: {
          ...position,
          resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "approval-1" }],
        },
        type: "input.resolved",
      }),
      callId: "another-call",
    });
    if (elsewhere === undefined) throw new Error("not a protocol 2 callback");
    expect(relay(viewOf(mirrored), { payload: elsewhere }).events).toEqual([]);
  });
});

describe("protocolTwoAnswersSettledOnForward", () => {
  it("settles questions and budget prompts on forward, but not approvals or a Stop", () => {
    const kinds: Record<string, "approval" | "question" | "budget"> = {
      "approval-1": "approval",
      "budget-1": "budget",
      "budget-2": "budget",
      "question-1": "question",
    };
    expect(
      protocolTwoAnswersSettledOnForward({
        answers: [
          { interactionId: "approval-1", optionId: "approve" },
          { interactionId: "question-1", text: "iad1" },
          { interactionId: "budget-1", optionId: "continue" },
          { interactionId: "budget-2", optionId: "deny" },
        ],
        decidedHere: "budget-2",
        kindOf: (interactionId) => kinds[interactionId],
      }),
    ).toEqual([
      { interactionId: "question-1", text: "iad1" },
      { interactionId: "budget-1", optionId: "continue" },
    ]);
  });
});
