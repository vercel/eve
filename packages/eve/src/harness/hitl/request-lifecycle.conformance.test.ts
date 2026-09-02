import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createRequests } from "#harness/input-requests.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import { interpretRequests } from "#harness/hitl/request-interpreter.js";
import {
  acknowledgeReadyRequestGroupDelivery,
  listReadyRequestGroupDeliveries,
  openRequestIds,
  readRequestLedger,
} from "#harness/hitl/request-ledger.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

function session(): HarnessSession {
  return {
    agent: { modelReference: {} as never, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
  };
}

function approval(requestId: string): InputRequest {
  return {
    action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "bash" },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve bash",
    requestId,
  };
}

function question(requestId: string): InputRequest {
  return {
    action: {
      callId: `${requestId}-call`,
      input: {},
      kind: "tool-call",
      toolName: "ask_question",
    },
    display: "text",
    kind: "question",
    prompt: "What next?",
    requestId,
  };
}

function responseMessages(requests: readonly InputRequest[]): ModelMessage[] {
  return [
    {
      content: requests.map((request) => ({
        input: request.action.input,
        toolCallId: request.action.callId,
        toolName: request.action.toolName,
        type: "tool-call" as const,
      })),
      role: "assistant",
    },
  ];
}

function appendGroup(current: HarnessSession, requests: readonly InputRequest[]): HarnessSession {
  return createRequests({
    requests,
    responseMessages: responseMessages(requests),
    session: current,
  });
}

const responder = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "user-1",
  principalType: "user",
} as const;

const approvalPolicies: HarnessToolMap = new Map([
  [
    "bash",
    {
      approval: {
        request: () => "user-approval" as const,
        response: async () => ({ status: "allowed" as const }),
      },
      description: "bash",
      inputSchema: { type: "object" },
      name: "bash",
    } as unknown as HarnessToolDefinition,
  ],
]);

describe("current HITL lifecycle conformance", () => {
  it("keeps a mixed group open until its approval is answered", async () => {
    const requests = [question("question-1"), approval("approval-1")];
    const parked = appendGroup(session(), requests);

    const result = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder: null,
        stepInput: { inputResponses: [{ optionId: "yes", requestId: "question-1" }] },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(parked.state),
      policies: new Map(),
    });

    expect(result.kind).toBe("wait");
    if (result.kind !== "wait") throw new Error("Expected wait");
    expect(openRequestIds({ "eve.runtime.hitl.requestLedger": result.ledger })).toEqual(
      new Set(["question-1", "approval-1"]),
    );
    expect(result.heldInput).toEqual({
      inputResponses: [{ optionId: "yes", requestId: "question-1" }],
    });
  });

  it("settles a mixed group when its approval is answered and dismisses an unanswered question", async () => {
    const requests = [question("question-1"), approval("approval-1")];
    const parked = appendGroup(session(), requests);

    const result = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder,
        stepInput: {
          attributedInputResponses: [
            {
              auth: responder,
              deliveryId: "delivery-1",
              response: { optionId: "approve", requestId: "approval-1" },
            },
          ],
        },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(parked.state),
      policies: approvalPolicies,
    });

    expect(result.kind).toBe("complete");
    expect(openRequestIds({ "eve.runtime.hitl.requestLedger": result.ledger })).toEqual(new Set());
    const records = readRequestLedger({ "eve.runtime.hitl.requestLedger": result.ledger }).requests;
    expect(records).toContainEqual(
      expect.objectContaining({ id: "question-1", outcome: { kind: "ignored", at: 1 } }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        id: "approval-1",
        outcome: expect.objectContaining({ kind: "approved" }),
      }),
    );
    if (result.kind === "complete") {
      expect(result.completions).toEqual([
        expect.objectContaining({ owner: "framework-approval-gate", approvedToolKeys: ["bash"] }),
      ]);
    }
  });

  it("answers an independent question group while an approval group remains open", async () => {
    let parked = appendGroup(session(), [approval("approval-1")]);
    parked = appendGroup(parked, [question("question-1")]);

    const result = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder: null,
        stepInput: { inputResponses: [{ text: "later", requestId: "question-1" }] },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(parked.state),
      policies: new Map(),
    });

    expect(result.kind).toBe("complete");
    expect(openRequestIds({ "eve.runtime.hitl.requestLedger": result.ledger })).toEqual(
      new Set(["approval-1"]),
    );
  });

  it("uses the last response when one delivery repeats a request id", async () => {
    const parked = appendGroup(session(), [approval("approval-1")]);

    const result = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder,
        stepInput: {
          attributedInputResponses: [
            {
              auth: responder,
              deliveryId: "delivery-1",
              response: { optionId: "cancel", requestId: "approval-1" },
            },
            {
              auth: responder,
              deliveryId: "delivery-2",
              response: { optionId: "approve", requestId: "approval-1" },
            },
          ],
        },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(parked.state),
      policies: approvalPolicies,
    });

    const approvalRecord = result.ledger.requests.find((record) => record.id === "approval-1");
    expect(approvalRecord?.outcome).toMatchObject({ kind: "approved" });
  });

  it("checkpoints ready completion before replaying and acknowledging owner delivery", async () => {
    const parked = appendGroup(session(), [question("question-1")]);

    const prepared = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder: null,
        stepInput: { inputResponses: [{ text: "later", requestId: "question-1" }] },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(parked.state),
      policies: new Map(),
    });
    expect(prepared.kind).toBe("complete");

    const preparedSession = {
      ...parked,
      state: { "eve.runtime.hitl.requestLedger": prepared.ledger },
    };
    expect(listReadyRequestGroupDeliveries(preparedSession.state)).toHaveLength(1);
    expect(readRequestLedger(preparedSession.state).groups[0]?.completion).toEqual(
      expect.objectContaining({ status: "ready" }),
    );

    if (prepared.kind !== "complete") throw new Error("Expected completion");
    const delivered = acknowledgeReadyRequestGroupDelivery({
      deliveryKey: prepared.deliveryKey,
      session: preparedSession,
    });

    expect(prepared.completions[0]).toEqual(expect.objectContaining({ owner: "session-turn" }));
    expect(readRequestLedger(delivered.state).groups[0]?.completion).toEqual(
      expect.objectContaining({ status: "delivered" }),
    );
  });

  it("gives an open limit group priority over responses for another group", async () => {
    let parked = appendGroup(session(), [approval("approval-1")]);
    parked = createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "session-1",
          violation: { kind: "input", limit: 10, usedTokens: 10 },
        }),
      ],
      responseMessages: [],
      session: parked,
    });

    const result = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder: null,
        stepInput: { inputResponses: [{ optionId: "approve", requestId: "approval-1" }] },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(parked.state),
      policies: new Map(),
    });

    expect(result.kind).toBe("wait");
    expect(openRequestIds({ "eve.runtime.hitl.requestLedger": result.ledger })).toEqual(
      new Set(["approval-1", "session-1:limit:input:10"]),
    );
  });
});
