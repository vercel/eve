import { describe, expect, it, vi } from "vitest";
import { jsonSchema } from "ai";
import type { ApprovalResponsePolicy } from "#approval/definition.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
} from "#harness/approval-candidates.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

import type { SessionAuthContext } from "#channel/types.js";
import { settleDirectApprovalResponse } from "#harness/approval-candidates.js";
import { coordinateApprovalDelivery } from "#harness/approval-delivery-coordinator.js";
import { selectApprovalReplayBatch } from "#harness/input-requests.js";
import { appendPendingInputBatch, getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const request: InputRequest = {
  action: { callId: "call-1", input: { marker: "durable" }, kind: "tool-call", toolName: "gate" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: gate",
  requestId: "approval-1",
};
const responder: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "user-1",
  principalType: "user",
};

function parkedSession(): HarnessSession {
  return appendPendingInputBatch({
    requests: [request],
    responseAuthRequiredRequestIds: [request.requestId],
    responseMessages: [],
    session: {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 0.8 },
      continuationToken: "test",
      history: [],
      sessionId: "session-1",
    },
  });
}

describe("coordinateApprovalDelivery", () => {
  function authorize(session: HarnessSession, response: ApprovalResponsePolicy) {
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
        session,
        tools: new Map([["gate", tool]]),
      }),
    );
  }

  async function ingest(session = parkedSession(), optionId = "approve") {
    return coordinateApprovalDelivery({
      now: 100,
      session,
      stepInput: {
        attributedInputResponses: [
          { auth: responder, response: { requestId: request.requestId, optionId } },
        ],
      },
      tools: new Map(),
    });
  }

  function parkedBy(auth: SessionAuthContext): HarnessSession {
    const ctx = new ContextContainer();
    ctx.set(AuthKey, auth);
    return contextStorage.run(ctx, parkedSession);
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
    const ingested = await ingest(parkedBy(requester), "cancel");
    expect(ingested.kind).toBe("continue-coordination");

    const onlyRequester: ApprovalResponsePolicy = ({ request, response }) =>
      response.principal.principalId === request.principal?.principalId
        ? { status: "allowed" }
        : { reason: "Only the requester can respond.", status: "rejected" };
    const response = vi.fn(onlyRequester);
    const rejected = await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ response: { decision: "cancel", principal: responder } }),
    );
    expect(rejected.stepInput?.inputResponses ?? []).toEqual([]);
    expect(getApprovalAuditState(rejected.session.state).settlements).toEqual([]);
    expect(getPendingInputBatches(rejected.session.state)).toHaveLength(1);

    const requesterCancel = await coordinateApprovalDelivery({
      now: 102,
      session: rejected.session,
      stepInput: {
        attributedInputResponses: [
          { auth: requester, response: { optionId: "cancel", requestId: request.requestId } },
        ],
      },
      tools: new Map(),
    });
    const settled = await authorize(requesterCancel.session, onlyRequester);
    expect(settled.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: request.requestId },
    ]);
  });

  it("authorizes ACP's Deny as a Cancel", async () => {
    const ingested = await ingest(parkedSession(), "deny");
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const settled = await authorize(ingested.session, response);
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ response: { decision: "cancel", principal: responder } }),
    );
    expect(settled.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: request.requestId },
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
      expect(result.stepInput?.inputResponses ?? []).toEqual(
        status === "allowed" ? [{ optionId: "approve", requestId: request.requestId }] : [],
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

  it("does not complete a duplicate while its candidate is active", async () => {
    const ingested = await ingest();
    const duplicate = await ingest(ingested.session);
    expect(duplicate.kind).toBe("continue");
    expect(getApprovalAuditState(duplicate.session.state).activeCandidates).toHaveLength(1);
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
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "approve", requestId: request.requestId },
    ]);
  });

  it("recovers a cancelled settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "cancelled",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: request.requestId },
    ]);
  });

  it("keeps an earlier settled response when the remaining batch response arrives", async () => {
    const secondRequest: InputRequest = {
      ...request,
      action: { ...request.action, callId: "call-2", toolName: "gate-2" },
      prompt: "Approve tool call: gate-2",
      requestId: "approval-2",
    };
    const parked = appendPendingInputBatch({
      requests: [request, secondRequest],
      responseMessages: [],
      session: {
        agent: { modelReference: { id: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 0.8 },
        continuationToken: "test",
        history: [],
        sessionId: "session-1",
      },
    });
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "allowed",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      stepInput: {
        inputResponses: [
          { optionId: "approve", requestId: request.requestId },
          { optionId: "approve", requestId: secondRequest.requestId },
        ],
      },
      tools: new Map(),
    });
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "approve", requestId: request.requestId },
      { optionId: "approve", requestId: secondRequest.requestId },
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
      getPendingInputBatches(result.session.state).flatMap((batch) =>
        batch.requests.map((pending) => pending.requestId),
      ),
    ).toEqual([request.requestId]);
  });
});

describe("approval responses without a response policy", () => {
  const alice: SessionAuthContext = { ...responder, principalId: "alice" };
  const bob: SessionAuthContext = { ...responder, principalId: "bob" };

  function parkedFor(requester: SessionAuthContext | null): HarnessSession {
    const base = appendPendingInputBatch({
      requests: [request],
      responseMessages: [],
      session: { ...parkedSession(), state: undefined },
    });
    if (requester === null) return base;
    const ctx = new ContextContainer();
    ctx.set(AuthKey, requester);
    return contextStorage.run(ctx, () =>
      appendPendingInputBatch({
        requests: [request],
        responseMessages: [],
        session: { ...parkedSession(), state: undefined },
      }),
    );
  }

  function respond(session: HarnessSession, auth: SessionAuthContext, optionId = "approve") {
    return coordinateApprovalDelivery({
      now: 100,
      session,
      stepInput: {
        attributedInputResponses: [{ auth, response: { optionId, requestId: request.requestId } }],
      },
      tools: new Map(),
    });
  }

  it("lets the requester settle the call", async () => {
    const result = await respond(parkedFor(alice), alice);
    expect(result.feedback).toEqual([]);
    expect(getApprovalAuditState(result.session.state).settlements).toHaveLength(1);
  });

  it.each(["approve", "cancel"])("rejects another principal's %s", async (optionId) => {
    const result = await respond(parkedFor(alice), bob, optionId);
    expect(result.feedback).toEqual([
      "Only the person who requested this action can respond to this approval.",
    ]);
    expect(getApprovalAuditState(result.session.state).settlements).toEqual([]);
    expect(result.stepInput?.inputResponses ?? []).toEqual([]);
    expect(getPendingInputBatches(result.session.state)).toHaveLength(1);
  });

  it("lets anyone respond when the requester is unauthenticated", async () => {
    const result = await respond(parkedFor(null), bob);
    expect(result.feedback).toEqual([]);
    expect(getApprovalAuditState(result.session.state).settlements).toHaveLength(1);
  });
});

describe("text approval replay preparation", () => {
  function shouldPrepareApprovalReplayTools(input: {
    session: HarnessSession;
    stepInput?: import("#harness/types.js").StepInput;
  }) {
    return selectApprovalReplayBatch(input.session, input.stepInput) !== undefined;
  }
  function sessionWithRequests(
    requests: InputRequest[] = [request],
    responseAuthRequiredRequestIds?: string[],
  ) {
    const base = parkedSession();
    return appendPendingInputBatch({
      requests,
      responseAuthRequiredRequestIds,
      responseMessages: [],
      session: { ...base, state: undefined },
    });
  }

  it.each(["approve", "APPROVE", "1"])("prepares a matching text approval: %s", (message) => {
    expect(
      shouldPrepareApprovalReplayTools({ session: sessionWithRequests(), stepInput: { message } }),
    ).toBe(true);
  });

  it.each(["cancel", "unrelated follow-up"])("does not prepare tools for %s", (message) => {
    expect(
      shouldPrepareApprovalReplayTools({ session: sessionWithRequests(), stepInput: { message } }),
    ).toBe(false);
  });

  it("does not treat a question option named approve as tool approval", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests([{ ...request, kind: "question" }]),
        stepInput: { message: "approve" },
      }),
    ).toBe(false);
  });

  it("does not bypass responder authorization with text", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests([request], [request.requestId]),
        stepInput: { message: "approve" },
      }),
    ).toBe(false);
  });

  it("does not interpret text when multiple batches are pending", () => {
    const session = appendPendingInputBatch({
      requests: [{ ...request, requestId: "approval-2" }],
      responseMessages: [],
      session: sessionWithRequests(),
    });
    expect(shouldPrepareApprovalReplayTools({ session, stepInput: { message: "approve" } })).toBe(
      false,
    );
  });

  it("preserves an explicit cancellation over approval text", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests(),
        stepInput: {
          message: "approve",
          inputResponses: [{ optionId: "cancel", requestId: request.requestId }],
        },
      }),
    ).toBe(false);
  });
});
