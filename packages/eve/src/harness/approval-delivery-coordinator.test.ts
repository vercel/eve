import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  getApprovalAuditState,
  settleDirectApprovalResponse,
} from "#harness/approval-candidates.js";
import {
  coordinateApprovalDelivery,
  shouldPrepareApprovalReplayTools,
} from "#harness/approval-delivery-coordinator.js";
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

  it("resolves a matching text reply for a response-authorized approval when the message is attributed", async () => {
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedSession(),
      stepInput: { message: "approve", messageAuth: responder },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue-coordination");
    expect(result.stepInput?.message).toBeUndefined();
    expect(getApprovalAuditState(result.session.state).activeCandidates).toMatchObject([
      { requestId: request.requestId, responder: { principalId: responder.principalId } },
    ]);
  });

  it("does not map one attributed text reply to multiple protected approvals", async () => {
    const secondRequest: InputRequest = {
      ...request,
      action: { ...request.action, callId: "call-2", toolName: "gate-2" },
      prompt: "Approve tool call: gate-2",
      requestId: "approval-2",
    };
    const parked = appendPendingInputBatch({
      requests: [request, secondRequest],
      responseAuthRequiredRequestIds: [request.requestId, secondRequest.requestId],
      responseMessages: [],
      session: { ...parkedSession(), state: undefined },
    });
    const stepInput = { message: "approve", messageAuth: responder };

    expect(shouldPrepareApprovalReplayTools({ session: parked, stepInput })).toBe(false);

    const result = await coordinateApprovalDelivery({ now: 100, session: parked, stepInput, tools: new Map() });

    expect(result.stepInput?.message).toBe("approve");
    expect(result.stepInput?.attributedInputResponses).toBeUndefined();
    expect(getApprovalAuditState(result.session.state).activeCandidates).toEqual([]);
  });

  it("does not resolve a response-authorized approval from unattributed text", async () => {
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedSession(),
      stepInput: { message: "approve", messageAuth: null },
      tools: new Map(),
    });

    expect(result.stepInput?.message).toBe("approve");
    expect(getApprovalAuditState(result.session.state).activeCandidates).toEqual([]);
  });
});

describe("text approval replay preparation", () => {
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

  it("prepares tools for a matching attributed text reply to a response-authorized approval", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests([request], [request.requestId]),
        stepInput: { message: "approve", messageAuth: responder },
      }),
    ).toBe(true);
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
