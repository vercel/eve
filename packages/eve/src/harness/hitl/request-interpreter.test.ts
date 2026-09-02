import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import { settleDirectApprovalResponse } from "#harness/hitl/approval-response-attempts.js";
import { interpretApprovalResponses } from "#harness/hitl/request-interpreter.js";
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

describe("interpretApprovalResponses", () => {
  it("recovers an allowed settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "allowed",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await interpretApprovalResponses({
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
    const result = await interpretApprovalResponses({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: request.requestId },
    ]);
  });

  it("forwards an unrelated message while a response-authorized approval remains pending", async () => {
    const messageAuth: SessionAuthContext = { ...responder, principalId: "user-2" };
    const result = await interpretApprovalResponses({
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

  it("deduplicates replay of the same attributed delivery", async () => {
    const parked = parkedSession();
    const first = await interpretApprovalResponses({
      now: 100,
      session: parked,
      stepInput: {
        attributedInputResponses: [
          {
            auth: responder,
            deliveryId: "delivery-1",
            response: { optionId: "approve", requestId: request.requestId },
          },
        ],
      },
      tools: new Map(),
    });
    const replay = await interpretApprovalResponses({
      now: 101,
      session: first.session,
      stepInput: {
        attributedInputResponses: [
          {
            auth: responder,
            deliveryId: "delivery-1",
            response: { optionId: "approve", requestId: request.requestId },
          },
        ],
      },
      tools: new Map(),
    });

    expect(first.session.state).toBeDefined();
    expect(replay.kind).toBe("continue");
  });

  it("creates distinct competing attempts for distinct deliveryIds from the same responder", async () => {
    const parked = parkedSession();
    const first = await interpretApprovalResponses({
      now: 100,
      session: parked,
      stepInput: {
        attributedInputResponses: [
          {
            auth: responder,
            deliveryId: "delivery-1",
            response: { optionId: "approve", requestId: request.requestId },
          },
        ],
      },
      tools: new Map(),
    });
    const second = await interpretApprovalResponses({
      now: 101,
      session: first.session,
      stepInput: {
        attributedInputResponses: [
          {
            auth: responder,
            deliveryId: "delivery-2",
            response: { optionId: "approve", requestId: request.requestId },
          },
        ],
      },
      tools: new Map(),
    });

    const pending = getPendingAuthorization(second.session.state);
    expect(second.kind).toBe("continue-coordination");
    expect(pending).toBeUndefined();
  });
});
