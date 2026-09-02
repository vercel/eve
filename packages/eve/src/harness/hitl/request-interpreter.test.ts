import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import type { ApprovalConfiguration } from "#approval/definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { interpretRequests } from "#harness/hitl/request-interpreter.js";
import {
  acknowledgeReadyRequestGroupDelivery,
  createRequests,
  listReadyRequestGroupDeliveries,
  openRequestGroups,
  readRequestLedger,
} from "#harness/hitl/request-ledger.js";
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

function emptySession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
  };
}

function parkedSession(): HarnessSession {
  return createRequests({
    requests: [request],
    responseAuthRequiredRequestIds: [request.requestId],
    responseMessages: [],
    session: emptySession(),
  });
}

function toolWithResponsePolicy(
  response: ApprovalConfiguration["response"],
): HarnessToolDefinition {
  return {
    approval: { request: () => "user-approval" as const, response },
    description: "test tool",
    inputSchema: { properties: {}, type: "object" },
    name: "gate",
  } as unknown as HarnessToolDefinition;
}

function runWithSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: responder, initiator: responder },
    sessionId: "session-1",
    turn: { id: "turn-1" } as never,
  });
  return contextStorage.run(ctx, fn);
}

describe("interpretRequests", () => {
  it("approves a response-authorized approval via policy and emits completion", async () => {
    const parked = parkedSession();
    const result = await runWithSessionContext(() =>
      interpretRequests({
        deferMessagesWhileApprovalsPending: false,
        delivery: {
          now: 100,
          responder,
          stepInput: {
            attributedInputResponses: [
              {
                auth: responder,
                deliveryId: "delivery-1",
                response: { optionId: "approve", requestId: request.requestId },
              },
            ],
          },
          authorizationResults: [],
        },
        history: [],
        ledger: readRequestLedger(parked.state),
        policies: new Map([
          ["gate", toolWithResponsePolicy(async () => ({ status: "allowed" as const }))],
        ]),
      }),
    );

    expect(result.kind).toBe("complete");
    const record = result.ledger.requests.find((candidate) => candidate.id === request.requestId);
    expect(record?.outcome).toMatchObject({
      kind: "approved",
      actor: expect.objectContaining({ principalId: "user-1" }),
      attemptId: expect.any(String),
      at: 100,
    });
    expect(result.effects).toContainEqual(
      expect.objectContaining({
        kind: "approval-settled",
        outcome: "approved",
        requestId: request.requestId,
      }),
    );
    if (result.kind === "complete") {
      expect(result.completions).toEqual([expect.objectContaining({ owner: "session-turn" })]);
    }
  });

  it("mixed framework-approval-gate and session-turn groups completing in one pass yield two typed completions under one deliveryKey", async () => {
    let current = createRequests({
      owner: "session-turn",
      requests: [
        {
          action: { callId: "call-question", input: {}, kind: "tool-call", toolName: "ask" },
          display: "text",
          kind: "question",
          prompt: "Continue?",
          requestId: "question-1",
        },
      ],
      responseMessages: [],
      session: emptySession(),
    });
    current = createRequests({
      owner: "framework-approval-gate",
      requests: [
        {
          action: { callId: "call-approval", input: {}, kind: "tool-call", toolName: "bash" },
          kind: "tool-approval",
          prompt: "Approve bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [],
      session: current,
    });

    const result = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 10,
        responder,
        stepInput: {
          attributedInputResponses: [
            {
              auth: responder,
              deliveryId: "delivery-approval",
              response: { optionId: "approve", requestId: "approval-1" },
            },
          ],
          inputResponses: [{ text: "yes", requestId: "question-1" }],
        },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(current.state),
      policies: new Map([
        ["bash", toolWithResponsePolicy(async () => ({ status: "allowed" as const }))],
      ]),
    });

    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.completions).toEqual([
        expect.objectContaining({ owner: "session-turn" }),
        expect.objectContaining({ owner: "framework-approval-gate" }),
      ]);
      const sessionWithReady = {
        ...current,
        state: { "eve.runtime.hitl.requestLedger": result.ledger },
      };
      expect(listReadyRequestGroupDeliveries(sessionWithReady.state)).toEqual([
        {
          deliveryKey: result.deliveryKey,
          ownerCompletion: result.completions[0],
          targets: [
            { groupId: "session-turn:0", owner: "session-turn" },
            { groupId: "session-turn:1", owner: "framework-approval-gate" },
          ],
        },
      ]);
      const acknowledged = acknowledgeReadyRequestGroupDelivery({
        deliveryKey: result.deliveryKey,
        session: sessionWithReady,
      });
      expect(openRequestGroups(acknowledged.state)).toEqual([]);
      expect(readRequestLedger(acknowledged.state).groups).toEqual([
        expect.objectContaining({
          completion: { deliveryKey: result.deliveryKey, status: "delivered" },
        }),
        expect.objectContaining({
          completion: { deliveryKey: result.deliveryKey, status: "delivered" },
        }),
      ]);
    }
  });

  it("an authorization callback settles the linked Authorization request and re-runs the held approval", async () => {
    // Pass 4 parks an approve attempt behind an internal Authorization request
    // when the response policy demands sign-in; that durable shape is seeded
    // here so the test exercises pass 2 (callback) and the policy re-run.
    const parked = parkedSession();
    const attemptId = `${request.requestId}:delivery-1`;
    const challenge = {
      attemptId: "auth-attempt-1",
      candidateId: attemptId,
      challenge: { type: "redirect" as const, url: "https://example.com/authorize" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    };
    const seeded = createRequests({
      authorizations: [{ challenge, responseAttemptId: attemptId }],
      requests: [],
      responseMessages: [],
      session: parked,
    });
    const seededLedger = readRequestLedger(seeded.state);
    const authorizationRecordId = seededLedger.requests.find(
      (candidate) => candidate.request.kind === "authorization",
    )?.id;
    if (authorizationRecordId === undefined) throw new Error("Expected an Authorization request.");
    const ledger = {
      ...seededLedger,
      requests: seededLedger.requests.map((record) =>
        record.id === request.requestId
          ? {
              ...record,
              attempts: [
                {
                  authorizationRequestIds: [authorizationRecordId],
                  createdAt: 100,
                  deliveryId: "delivery-1",
                  expiresAt: 100 + 10 * 60_000,
                  id: attemptId,
                  responder,
                  status: "awaiting-authorization" as const,
                },
              ],
            }
          : record,
      ),
    };
    expect(
      getPendingAuthorization({ "eve.runtime.hitl.requestLedger": ledger })?.challenges,
    ).toEqual([challenge]);

    const policy = vi.fn(async () => ({ status: "allowed" as const }));
    const result = await runWithSessionContext(() =>
      interpretRequests({
        deferMessagesWhileApprovalsPending: false,
        delivery: {
          authorizationResults: [
            {
              attemptId: challenge.attemptId,
              callback: { method: "GET", params: { code: "ok" } },
              hookUrl: challenge.hookUrl,
            },
          ],
          now: 101,
          responder: null,
        },
        history: [],
        ledger,
        policies: new Map([["gate", toolWithResponsePolicy(policy)]]),
      }),
    );

    expect(policy).toHaveBeenCalledTimes(1);
    const authorizationRecord = result.ledger.requests.find(
      (candidate) => candidate.id === authorizationRecordId,
    );
    expect(authorizationRecord?.outcome).toMatchObject({ kind: "authorized", at: 101 });
    expect(
      result.ledger.requests.find((candidate) => candidate.id === request.requestId)?.outcome,
    ).toMatchObject({
      attemptId,
      kind: "approved",
    });
    expect(result.effects).toEqual([
      expect.objectContaining({
        kind: "authorization-completed",
        outcome: "completed",
        requestId: authorizationRecordId,
      }),
      expect.objectContaining({
        kind: "approval-settled",
        outcome: "approved",
        requestId: request.requestId,
      }),
    ]);
    expect(result.kind).toBe("complete");
    expect(
      getPendingAuthorization({ "eve.runtime.hitl.requestLedger": result.ledger }),
    ).toBeUndefined();
  });
});
