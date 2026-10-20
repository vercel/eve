import { readHitlState, writeHitlState } from "./requests.js";
import { describe, expect, it, vi } from "vitest";
import { jsonSchema } from "ai";
import type { ApprovalResponsePolicy } from "#approval/definition.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import {
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
} from "#harness/hitl/candidates.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

import type { SessionAuthContext } from "#channel/types.js";
import { settleDirectApprovalResponse } from "#harness/hitl/candidates.js";
import { coordinateApprovalDelivery } from "#harness/hitl/coordinator.js";
import { approvingSteps } from "#harness/hitl/approvals.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { resolveTypedApproval } from "#harness/hitl/delivery.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { parkedSteps, withParkedStep } from "#internal/testing/session-machine.js";
import type { HarnessSession, HarnessStepInput } from "#harness/types.js";
import type { ApprovalAsk } from "#harness/session-machine/state.js";

const request: ApprovalAsk = {
  call: { callId: "call-1", input: { marker: "durable" }, toolName: "gate" },
  interactionId: "approval-1",
  request: {
    allowFreeform: false,
    display: "confirmation",
    kind: "approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Cancel" },
    ],
    prompt: "Approve tool call: gate",
  },
};
const responder: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "user-1",
  principalType: "user",
};

function viewOf(session: HarnessSession) {
  return sessionView(storedProjection(session.state), session.state);
}

function parkedSession(requester?: SessionAuthContext): HarnessSession {
  return withParkedStep(
    {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 0.8 },
      continuationToken: "test",
      history: [],
      sessionId: "session-1",
    },
    { requester, requests: [request], responseAuthRequiredRequestIds: [request.interactionId] },
  );
}

describe("coordinateApprovalDelivery", () => {
  function authorize(
    session: HarnessSession,
    response: ApprovalResponsePolicy,
    prepareTools?: () => Promise<Map<string, HarnessToolDefinition>>,
    stepInput?: HarnessStepInput,
  ) {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: responder, initiator: responder },
      sessionId: session.sessionId,
      turn: { id: "turn-1", sequence: 1 },
    });
    const tool: HarnessToolDefinition = {
      name: "gate",
      description: "A gated tool.",
      inputSchema: jsonSchema({ type: "object" }),
      execute: async () => "done",
      approval: { request: () => "user-approval", response },
    };
    return contextStorage.run(ctx, () =>
      coordinateApprovalDelivery({
        now: 101,
        prepareTools,
        session,
        stepInput,
        tools: new Map([["gate", tool]]),
      }),
    );
  }

  async function ingest(session = parkedSession(), optionId = "approve") {
    return coordinateApprovalDelivery({
      now: 100,
      session,
      stepInput: {
        attributedAnswers: [
          { auth: responder, response: { interactionId: request.interactionId, optionId } },
        ],
      },
      tools: new Map(),
    });
  }

  function parkedBy(auth: SessionAuthContext): HarnessSession {
    return parkedSession(auth);
  }

  it("passes the requester the batch parked with to the response policy", async () => {
    const requester: SessionAuthContext = { ...responder, principalId: "bob" };
    const ingested = await ingest(parkedBy(requester));
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ principal: requester }),
        response: { decision: "approve", principal: responder },
      }),
    );
  });

  it("authorizes Cancel, leaving a rejected Cancel pending for the requester", async () => {
    const requester: SessionAuthContext = { ...responder, principalId: "bob" };
    const ingested = await ingest(parkedBy(requester), "deny");
    expect(ingested.kind).toBe("continue-coordination");

    const onlyRequester: ApprovalResponsePolicy = ({ request, response }) =>
      response.principal.principalId === request.principal?.principalId
        ? { status: "allowed" }
        : { reason: "Only the requester can respond.", status: "rejected" };
    const response = vi.fn(onlyRequester);
    const rejected = await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ response: { decision: "deny", principal: responder } }),
    );
    expect(rejected.stepInput?.answers ?? []).toEqual([]);
    expect(getApprovalAuditState(rejected.session.state).settlements).toEqual([]);
    expect(parkedSteps(rejected.session)).toHaveLength(1);

    const requesterCancel = await coordinateApprovalDelivery({
      now: 102,
      session: rejected.session,
      stepInput: {
        attributedAnswers: [
          {
            auth: requester,
            response: { optionId: "deny", interactionId: request.interactionId },
          },
        ],
      },
      tools: new Map(),
    });
    const settled = await authorize(requesterCancel.session, onlyRequester);
    expect(settled.stepInput?.answers).toEqual([
      { optionId: "deny", interactionId: request.interactionId },
    ]);
  });

  it("authorizes ACP's Deny as a Cancel", async () => {
    const ingested = await ingest(parkedSession(), "deny");
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const settled = await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ response: { decision: "deny", principal: responder } }),
    );
    expect(settled.stepInput?.answers).toEqual([
      { optionId: "deny", interactionId: request.interactionId },
    ]);
  });

  it("records no requester for an anonymous caller", async () => {
    const anonymous: SessionAuthContext = {
      attributes: {},
      authenticator: "none",
      principalId: "anonymous",
      principalType: "anonymous",
    };
    const ingested = await ingest(parkedBy(anonymous));
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ principal: null }) }),
    );
  });

  it.each(["rejected", "failed", "allowed"] as const)(
    "explicitly completes %s candidates only after ingestion",
    async (status) => {
      const ingested = await ingest();
      expect(ingested.kind).toBe("continue-coordination");
      expect(getApprovalAuditState(ingested.session.state).activeCandidates).toHaveLength(1);
      const response = vi.fn(() => {
        if (status === "failed") throw new Error("policy unavailable");
        return { status, reason: "Not an eligible responder." };
      });
      const result = await authorize(ingested.session, response);
      expect(response).toHaveBeenCalledOnce();
      expect(result.kind).toBe("responses-completed");
      expect(getApprovalAuditState(result.session.state).activeCandidates).toEqual([]);
      expect(getApprovalAuditState(result.session.state).candidateHistory[0]?.status).toBe(status);
      expect(result.stepInput?.answers ?? []).toEqual(
        status === "allowed" ? [{ optionId: "approve", interactionId: request.interactionId }] : [],
      );
      const repeated = await authorize(result.session, response);
      expect(repeated.kind).toBe("continue");
      expect(response).toHaveBeenCalledOnce();
    },
  );

  it("completes an expired candidate without executing policy", async () => {
    const ingested = await ingest();
    const result = await coordinateApprovalDelivery({
      now: 600_100,
      session: ingested.session,
      tools: new Map(),
    });
    expect(result.kind).toBe("responses-completed");
    expect(getApprovalAuditState(result.session.state).candidateHistory[0]?.status).toBe(
      "timed-out",
    );
  });

  it("withdraws only the expired candidate's sign-ins through a transition", async () => {
    const ingested = await ingest();
    const candidate = getApprovalAuditState(ingested.session.state).activeCandidates[0]!;
    const expired = {
      name: "expired",
      hookUrl: "https://example.com/expired",
      challenge: { url: "https://example.com/login" },
    };
    const retained = {
      name: "retained",
      hookUrl: "https://example.com/retained",
      challenge: { url: "https://example.com/login" },
    };
    const session = writeHitlState(
      {
        ...ingested.session,
        state: markApprovalCandidateAuthorizationRequired({
          candidateId: candidate.candidateId,
          state: ingested.session.state,
          authorizationChallenges: [expired],
        }),
      },
      { signIns: [expired, retained] },
    );
    const result = await coordinateApprovalDelivery({ now: 600_100, session, tools: new Map() });
    expect(readHitlState(result.session.state).signIns).toEqual([retained]);
  });

  it("completes a failed authorizer timeout", async () => {
    vi.useFakeTimers();
    try {
      const ingested = await ingest();
      const pending = authorize(ingested.session, () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.kind).toBe("responses-completed");
      expect(getApprovalAuditState(result.session.state).candidateHistory[0]?.status).toBe(
        "failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the candidate but keeps the request parked when its step's tools can't be restored", async () => {
    const logs = captureLogRecords();
    const ingested = await ingest();
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));

    const result = await authorize(ingested.session, response, async () => {
      throw new Error("The notes directory is unreachable.");
    });

    expect(response).not.toHaveBeenCalled();
    expect(getApprovalAuditState(result.session.state).candidateHistory).toEqual([
      expect.objectContaining({
        reason: "Approval authorization is temporarily unavailable. Please try again.",
        status: "failed",
      }),
    ]);
    // A restore failure may be transient, so the request waits for another response.
    expect(parkedSteps(result.session)[0]?.requests.map((entry) => entry.interactionId)).toEqual([
      request.interactionId,
    ]);
    expect(logs.records.map((record) => record.message)).toContain(
      "approval tools could not be restored",
    );
  });

  it("authorizes the active candidate once when its duplicate arrives", async () => {
    const ingested = await ingest();
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const duplicate = await authorize(ingested.session, response, undefined, {
      attributedAnswers: [
        {
          auth: responder,
          response: { interactionId: request.interactionId, optionId: "approve" },
        },
      ],
    });
    expect(response).toHaveBeenCalledOnce();
    expect(duplicate.kind).toBe("responses-completed");
    expect(duplicate.stepInput?.answers).toEqual([
      { interactionId: request.interactionId, optionId: "approve" },
    ]);
  });

  it("authorizes the active candidate when a sibling's direct answer arrives", async () => {
    const direct: ApprovalAsk = {
      ...request,
      call: { ...request.call, callId: "call-2" },
      interactionId: "approval-2",
    };
    const parked = withParkedStep(
      {
        agent: { modelReference: { id: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 0.8 },
        continuationToken: "test",
        history: [],
        sessionId: "session-1",
      },
      {
        requester: responder,
        requests: [request, direct],
        responseAuthRequiredRequestIds: [request.interactionId],
      },
    );
    const ingested = await ingest(parked);
    expect(ingested.kind).toBe("continue-coordination");

    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const result = await authorize(ingested.session, response, undefined, {
      attributedAnswers: [
        { auth: responder, response: { interactionId: direct.interactionId, optionId: "approve" } },
      ],
    });
    expect(response).toHaveBeenCalledOnce();
    expect(result.kind).toBe("responses-completed");
    expect(getApprovalAuditState(result.session.state).activeCandidates).toEqual([]);
    expect(result.stepInput?.answers).toEqual(
      expect.arrayContaining([
        { interactionId: request.interactionId, optionId: "approve" },
        { interactionId: direct.interactionId, optionId: "approve" },
      ]),
    );
  });

  it("keeps authorization-required candidates parked instead of completing", async () => {
    const ingested = await ingest();
    const candidate = getApprovalAuditState(ingested.session.state).activeCandidates[0]!;
    const session = {
      ...ingested.session,
      state: markApprovalCandidateAuthorizationRequired({
        candidateId: candidate.candidateId,
        state: ingested.session.state,
        authorizationChallenges: [
          {
            name: "provider",
            hookUrl: "https://example.com/callback",
            challenge: { url: "https://example.com/login" },
          },
        ],
      }),
    };
    const response = vi.fn(() => ({ status: "allowed" as const }));
    const result = await authorize(session, response);
    expect(result.kind).toBe("authorization-required");
    expect(response).not.toHaveBeenCalled();
  });

  it("recovers an allowed settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "allowed",
      requestId: request.interactionId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.answers).toEqual([
      { optionId: "approve", interactionId: request.interactionId },
    ]);
  });

  it("recovers a cancelled settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "cancelled",
      requestId: request.interactionId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.answers).toEqual([
      { optionId: "deny", interactionId: request.interactionId },
    ]);
  });

  it("keeps an earlier settled response when the remaining batch response arrives", async () => {
    const secondRequest: ApprovalAsk = {
      call: { ...request.call, callId: "call-2", toolName: "gate-2" },
      interactionId: "approval-2",
      request: { ...request.request, prompt: "Approve tool call: gate-2" },
    };
    const parked = withParkedStep(
      {
        agent: { modelReference: { id: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 0.8 },
        continuationToken: "test",
        history: [],
        sessionId: "session-1",
      },
      { requests: [request, secondRequest] },
    );
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "allowed",
      requestId: request.interactionId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      stepInput: {
        answers: [
          { optionId: "approve", interactionId: request.interactionId },
          { optionId: "approve", interactionId: secondRequest.interactionId },
        ],
      },
      tools: new Map(),
    });
    expect(result.stepInput?.answers).toEqual([
      { optionId: "approve", interactionId: request.interactionId },
      { optionId: "approve", interactionId: secondRequest.interactionId },
    ]);
  });

  it("asks the response policy about the person who typed approve", async () => {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: responder, initiator: responder },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    });
    const session = parkedSession();
    const ingested = await contextStorage.run(ctx, () =>
      coordinateApprovalDelivery({
        now: 100,
        session,
        stepInput: resolveTypedApproval(viewOf(session), { message: "approve" }),
        tools: new Map(),
      }),
    );
    expect(ingested.kind).toBe("continue-coordination");
    expect(ingested.stepInput?.message).toBeUndefined();

    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const settled = await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ response: { decision: "approve", principal: responder } }),
    );
    expect(settled.stepInput?.answers).toEqual([
      { optionId: "approve", interactionId: request.interactionId },
    ]);
  });

  it("keeps the note an authorized Cancel was sent with", async () => {
    const ingested = await coordinateApprovalDelivery({
      now: 100,
      session: parkedSession(),
      stepInput: {
        attributedAnswers: [
          {
            auth: responder,
            response: {
              interactionId: request.interactionId,
              optionId: "deny",
              text: "only the three-pack",
            },
          },
        ],
      },
      tools: new Map(),
    });
    const settled = await authorize(ingested.session, () => ({ status: "allowed" }));
    expect(settled.stepInput?.answers).toEqual([
      { interactionId: request.interactionId, optionId: "deny", text: "only the three-pack" },
    ]);
  });

  it("forwards an unrelated message while a response-authorized approval remains pending", async () => {
    const messageAuth: SessionAuthContext = { ...responder, principalId: "user-2" };
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedSession(),
      stepInput: {
        message: "What else can you help with?",
        messageAuth,
      },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue");
    expect(result.feedback).toEqual([]);
    expect(result.stepInput?.message).toBe("What else can you help with?");
    expect(result.stepInput?.messageAuth).toEqual(messageAuth);
    expect(
      parkedSteps(result.session).flatMap((batch) =>
        batch.requests.map((pending) => pending.interactionId),
      ),
    ).toEqual([request.interactionId]);
  });
});

describe("approval responses without a response policy", () => {
  const alice: SessionAuthContext = { ...responder, principalId: "alice" };
  const bob: SessionAuthContext = { ...responder, principalId: "bob" };

  function parkedFor(requester: SessionAuthContext | null): HarnessSession {
    return withParkedStep(
      { ...parkedSession(), state: undefined },
      { requester: requester ?? undefined, requests: [request] },
    );
  }

  function respond(session: HarnessSession, auth: SessionAuthContext, optionId = "approve") {
    return coordinateApprovalDelivery({
      now: 100,
      session,
      stepInput: {
        attributedAnswers: [{ auth, response: { optionId, interactionId: request.interactionId } }],
      },
      tools: new Map(),
    });
  }

  it("lets the requester settle the call", async () => {
    const result = await respond(parkedFor(alice), alice);
    expect(result.feedback).toEqual([]);
    expect(getApprovalAuditState(result.session.state).settlements).toHaveLength(1);
  });

  it.each(["approve", "deny"])("rejects another principal's %s", async (optionId) => {
    const result = await respond(parkedFor(alice), bob, optionId);
    expect(result.feedback).toEqual([
      "Only the person who requested this action can respond to this approval.",
    ]);
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([]);
    expect(result.stepInput?.answers ?? []).toEqual([]);
    expect(parkedSteps(result.session)).toHaveLength(1);
  });

  it("doesn't recheck a settled answer replayed with another responder's delivery", async () => {
    const second: ApprovalAsk = {
      ...request,
      call: { ...request.call, callId: "call-2" },
      interactionId: "approval-2",
    };
    const parked = withParkedStep(
      { ...parkedSession(), state: undefined },
      { requester: alice, requests: [request, second] },
    );
    const settled = await respond(parked, alice);
    // `answer` queues the settled response while the batch waits; Bob's delivery brings it back.
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: bob, initiator: alice },
      sessionId: parked.sessionId,
      turn: { id: "turn-2", sequence: 2 },
    });
    const replayed = await contextStorage.run(ctx, () =>
      coordinateApprovalDelivery({
        now: 101,
        session: settled.session,
        stepInput: {
          answers: settled.stepInput?.answers,
          attributedAnswers: [
            { auth: bob, response: { interactionId: second.interactionId, optionId: "approve" } },
          ],
        },
        tools: new Map(),
      }),
    );
    expect(replayed.feedback).toEqual([
      "Only the person who requested this action can respond to this approval.",
    ]);
    expect(
      getApprovalAuditState(replayed.session.state).settlements.map((entry) => entry.requestId),
    ).toEqual([request.interactionId]);
    expect(replayed.stepInput?.answers).toEqual([
      { interactionId: request.interactionId, optionId: "approve" },
    ]);
  });

  it.each([
    ["an unknown option", { optionId: "bogus" }],
    ["text alone", { text: "hmm, not sure" }],
  ])("rejects %s with feedback and settles nothing", async (_label, answer) => {
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedFor(alice),
      stepInput: {
        attributedAnswers: [
          { auth: alice, response: { ...answer, interactionId: request.interactionId } },
        ],
      },
      tools: new Map(),
    });
    expect(result.feedback).toEqual(["Respond to this approval with Approve or Cancel."]);
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([]);
    expect(result.stepInput?.answers ?? []).toEqual([]);
    expect(parkedSteps(result.session)).toHaveLength(1);
  });

  it("lets anyone respond when the requester is unauthenticated", async () => {
    const result = await respond(parkedFor(null), bob);
    expect(result.feedback).toEqual([]);
    expect(getApprovalAuditState(result.session.state).settlements).toHaveLength(1);
  });

  it("settles nothing for an unauthenticated answer to a requester's call", async () => {
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedFor(alice),
      stepInput: {
        attributedAnswers: [
          { auth: null, response: { interactionId: request.interactionId, optionId: "approve" } },
        ],
      },
      tools: new Map(),
    });
    expect(result.feedback).toEqual(["Authentication is required to respond to this approval."]);
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([]);
    expect(result.stepInput?.answers ?? []).toEqual([]);
    expect(parkedSteps(result.session)).toHaveLength(1);
  });

  it("keeps the requester's Cancel decisive after an unauthenticated answer", async () => {
    const afterAnonymous = await coordinateApprovalDelivery({
      now: 100,
      session: parkedFor(alice),
      stepInput: {
        attributedAnswers: [
          { auth: null, response: { interactionId: request.interactionId, optionId: "approve" } },
        ],
      },
      tools: new Map(),
    });
    const result = await respond(afterAnonymous.session, alice, "deny");
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([
      expect.objectContaining({ outcome: "cancelled" }),
    ]);
  });

  it("records an unauthenticated answer as the anonymous principal", async () => {
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedFor(null),
      stepInput: {
        attributedAnswers: [
          { auth: null, response: { interactionId: request.interactionId, optionId: "approve" } },
        ],
      },
      tools: new Map(),
    });
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ principalId: "anonymous", principalType: "anonymous" }),
        outcome: "allowed",
      }),
    ]);
    expect(result.stepInput?.answers).toEqual([
      { interactionId: request.interactionId, optionId: "approve" },
    ]);
  });
});

describe("text approval replay preparation", () => {
  function shouldPrepareApprovalReplayTools(input: {
    session: HarnessSession;
    stepInput?: HarnessStepInput;
  }) {
    const view = viewOf(input.session);
    return approvingSteps(view, resolveTypedApproval(view, input.stepInput)).length > 0;
  }
  function sessionWithRequests(
    requests: ApprovalAsk[] = [request],
    responseAuthRequiredRequestIds?: string[],
  ) {
    const base = parkedSession();
    return withParkedStep(
      { ...base, state: undefined },
      { requests, responseAuthRequiredRequestIds },
    );
  }

  it.each(["approve", "APPROVE", "1"])("prepares a matching text approval: %s", (message) => {
    expect(
      shouldPrepareApprovalReplayTools({ session: sessionWithRequests(), stepInput: { message } }),
    ).toBe(true);
  });

  it.each(["deny", "unrelated follow-up"])("does not prepare tools for %s", (message) => {
    expect(
      shouldPrepareApprovalReplayTools({ session: sessionWithRequests(), stepInput: { message } }),
    ).toBe(false);
  });

  it("answers only the first open approval by text", () => {
    const second = { ...request, interactionId: "approval-2" };
    const session = withParkedStep(sessionWithRequests(), {
      event: { sequence: 2, stepIndex: 0, turnId: "turn-2" },
      requests: [second],
    });
    expect(resolveTypedApproval(viewOf(session), { message: "approve" })?.answers).toEqual([
      { optionId: "approve", interactionId: request.interactionId },
    ]);
    expect(
      resolveTypedApproval(viewOf(session), {
        answers: [{ optionId: "approve", interactionId: request.interactionId }],
        message: "deny",
      })?.answers,
    ).toEqual([
      { optionId: "approve", interactionId: request.interactionId },
      { optionId: "deny", interactionId: second.interactionId },
    ]);
  });

  it("preserves an explicit cancellation over approval text", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests(),
        stepInput: {
          message: "approve",
          answers: [{ optionId: "deny", interactionId: request.interactionId }],
        },
      }),
    ).toBe(false);
  });
});
