import { describe, expect, it } from "vitest";

import { interpretRequests } from "#harness/hitl/request-interpreter.js";
import {
  acknowledgeReadyRequestGroupDelivery,
  authorizationRequestId,
  classifyRequestResponse,
  closeRequestLedger,
  commitRequestLedger,
  createRequests,
  getPendingAuthorization,
  isOpenRequest,
  listReadyRequestGroupDeliveries,
  openRequestGroups,
  readRequestLedger,
  RequestLedgerConflictError,
} from "#harness/hitl/request-ledger.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

function session(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: {} as never, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
    state,
  };
}

function approval(requestId: string, callId: string): InputRequest {
  return {
    action: { callId, input: {}, kind: "tool-call", toolName: "bash" },
    kind: "tool-approval",
    prompt: "Approve bash",
    requestId,
  };
}

function question(requestId: string, callId: string): InputRequest {
  return {
    action: { callId, input: {}, kind: "tool-call", toolName: "ask_question" },
    display: "text",
    kind: "question",
    prompt: "Which option?",
    requestId,
  };
}

const DUPLICATE_ID_ERROR =
  'Internal pending input invariant violated: requestId must be unique across all pending batches: "duplicate".';

const request: InputRequest = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
  kind: "question",
  prompt: "What next?",
  requestId: "request-1",
};

describe("request ledger", () => {
  it("imports a legacy pending batch without mutating the session", () => {
    const legacy = session({
      "eve.runtime.pendingInputBatch": { requests: [request], responseMessages: [] },
    });

    expect(readRequestLedger(legacy.state)).toMatchObject({
      groups: [{ completion: "waiting", requestIds: ["request-1"] }],
      requests: [{ id: "request-1" }],
      version: 0,
    });
    expect(legacy.state).toHaveProperty("eve.runtime.pendingInputBatch");
  });

  it("writes the ledger and removes legacy batch keys on first mutation", () => {
    const legacy = session({
      "eve.runtime.pendingInputBatch": { requests: [request], responseMessages: [] },
    });
    const ledger = readRequestLedger(legacy.state);
    const migrated = commitRequestLedger(legacy, ledger, ledger.version);

    expect(migrated.state).not.toHaveProperty("eve.runtime.pendingInputBatch");
    expect(readRequestLedger(migrated.state).version).toBe(1);
  });

  it("rejects a stale conditional write", () => {
    const created = createRequests({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    const ledger = readRequestLedger(created.state);

    expect(() => commitRequestLedger(created, ledger, ledger.version - 1)).toThrow(
      RequestLedgerConflictError,
    );
  });

  it("distinguishes open, stale, and invalid responses", () => {
    const created = createRequests({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    expect(classifyRequestResponse(created.state, "request-1")).toBe("open");
    expect(classifyRequestResponse(created.state, "unknown")).toBe("invalid");

    const delivered = closeRequestLedger(created, 1);
    expect(classifyRequestResponse(delivered.state, "request-1")).toBe("stale");
  });

  it("retains terminal requests after a group is closed", () => {
    const created = createRequests({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    const delivered = closeRequestLedger(created, 1);

    expect(openRequestGroups(delivered.state)).toEqual([]);
    expect(readRequestLedger(delivered.state)).toMatchObject({
      groups: [{ completion: "cancelled" }],
      requests: [{ id: "request-1", outcome: { kind: "cancelled", at: 1 } }],
    });
  });
});

describe("pending input request ID uniqueness", () => {
  it("allows duplicate IDs within a newly created group by replacing the later duplicate", () => {
    const created = createRequests({
      requests: [approval("duplicate", "call-1"), question("duplicate", "call-2")],
      responseMessages: [],
      session: session(),
    });

    expect(readRequestLedger(created.state).requests).toEqual([
      expect.objectContaining({ id: "duplicate", request: question("duplicate", "call-2") }),
    ]);
  });

  it("rejects an approval/question ID collision across newly created groups", () => {
    const first = createRequests({
      requests: [approval("duplicate", "call-1")],
      responseMessages: [],
      session: session(),
    });

    expect(() =>
      createRequests({
        requests: [question("duplicate", "call-2")],
        responseMessages: [],
        session: first,
      }),
    ).toThrow(DUPLICATE_ID_ERROR);
  });

  it("rejects duplicate IDs in a persisted group collection", () => {
    const persisted = session({
      "eve.runtime.pendingInputBatches": [
        { requests: [approval("duplicate", "call-1")], responseMessages: [] },
        { requests: [question("duplicate", "call-2")], responseMessages: [] },
      ],
    });

    expect(() => readRequestLedger(persisted.state)).toThrow(DUPLICATE_ID_ERROR);
  });

  it("rejects duplicate IDs in a persisted legacy singleton", () => {
    const persisted = session({
      "eve.runtime.pendingInputBatch": {
        requests: [question("duplicate", "call-1"), question("duplicate", "call-2")],
        responseMessages: [],
      },
    });

    expect(() => openRequestGroups(persisted.state)).toThrow(DUPLICATE_ID_ERROR);
  });
});

describe("persisted pending input validation", () => {
  it("ignores a persisted unknown request kind when reading open groups", () => {
    const persisted = session({
      "eve.runtime.pendingInputBatches": [
        {
          requests: [
            {
              ...question("unknown-kind", "call-unknown"),
              kind: "future-input-kind",
            },
          ],
          responseMessages: [],
        },
      ],
    });

    expect(openRequestGroups(persisted.state)).toEqual([]);
  });
});

describe("request ledger extension migration", () => {
  it("reads legacy approval-attempt state from persisted ledger", () => {
    const legacy = session({
      "eve.runtime.hitl.requestLedger": {
        groups: [
          {
            completion: "waiting",
            id: "session-turn:0",
            owner: "session-turn",
            requestIds: ["request-1"],
            responseMessages: [],
          },
        ],
        requests: [
          { groupId: "session-turn:0", id: "request-1", request: approval("request-1", "call-1") },
        ],
        responseAttempts: {
          activeResponseAttempts: {
            candidate1: {
              attemptId: "candidate1",
              candidateId: "candidate1",
              createdAt: 1,
              expiresAt: 10,
              requestId: "request-1",
              responder: {
                attributes: {},
                authenticator: "test",
                principalId: "user-1",
                principalType: "user",
              },
              status: "pending",
            },
          },
          responseAttemptHistory: [],
          settlements: {},
        },
        version: 0,
      },
    });

    expect(readRequestLedger(legacy.state).requests).toContainEqual(
      expect.objectContaining({
        attempts: [expect.objectContaining({ id: "candidate1", status: "pending" })],
        id: "request-1",
      }),
    );
  });

  it("reads legacy Authorization state and removes its key on write", () => {
    const challenge = {
      challenge: { url: "https://example.com" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    } as const;
    const legacy = { "eve.runtime.pendingAuthorization": { challenges: [challenge] } };
    expect(readRequestLedger(legacy).requests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ authorization: challenge, kind: "authorization" }),
      }),
    );

    const migrated = commitRequestLedger(session(legacy), readRequestLedger(legacy), 0);
    expect(migrated.state).not.toHaveProperty("eve.runtime.pendingAuthorization");
    expect(readRequestLedger(migrated.state).requests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ authorization: challenge, kind: "authorization" }),
      }),
    );
    expect(openRequestGroups(migrated.state)).toEqual([]);
  });

  it("retains completed Authorization requests as terminal records", () => {
    const challenge = {
      attemptId: "authorization-1",
      challenge: { url: "https://example.com" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    } as const;
    const id = authorizationRequestId({ challenge });
    const persisted = {
      "eve.runtime.hitl.requestLedger": {
        groups: [],
        requests: [
          {
            id,
            request: { authorization: challenge, kind: "authorization", requestId: id },
            outcome: {
              kind: "authorized",
              result: {
                attemptId: "authorization-1",
                callback: { method: "GET", params: {} },
                hookUrl: challenge.hookUrl,
              },
              at: 1,
            },
          },
        ],
        version: 1,
      },
    };

    expect(readRequestLedger(persisted).requests).toContainEqual(
      expect.objectContaining({ id, outcome: expect.objectContaining({ kind: "authorized" }) }),
    );
  });
});

describe("request group owners", () => {
  it("stores the framework approval gate as the owner of an approval group", () => {
    const approvalRequest: InputRequest = {
      action: { callId: "call-approval", input: {}, kind: "tool-call", toolName: "bash" },
      kind: "tool-approval",
      prompt: "Approve bash",
      requestId: "approval-1",
    };
    const created = createRequests({
      owner: "framework-approval-gate",
      requests: [approvalRequest],
      responseMessages: [],
      session: session(),
    });

    expect(readRequestLedger(created.state).groups[0]?.owner).toBe("framework-approval-gate");
  });

  it("defaults non-gate groups to the session-turn owner", () => {
    const created = createRequests({
      requests: [request],
      responseMessages: [],
      session: session(),
    });

    expect(readRequestLedger(created.state).groups[0]?.owner).toBe("session-turn");
  });
});

describe("request group completion delivery", () => {
  it("marks resolved groups ready and lists deliveries in group order", async () => {
    const request2: InputRequest = {
      action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "ask_question" },
      kind: "question",
      prompt: "Second?",
      requestId: "request-2",
    };
    let current = createRequests({
      owner: "framework-approval-gate",
      requests: [request2],
      responseMessages: [],
      session: session(),
    });
    current = createRequests({ requests: [request], responseMessages: [], session: current });

    const first = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 1,
        responder: null,
        stepInput: { inputResponses: [{ requestId: "request-2", text: "ok" }] },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(current.state),
      policies: new Map(),
    });
    current = commitRequestLedger(current, first.ledger, 2);

    const second = await interpretRequests({
      deferMessagesWhileApprovalsPending: false,
      delivery: {
        now: 2,
        responder: null,
        stepInput: { inputResponses: [{ requestId: "request-1", text: "later" }] },
        authorizationResults: [],
      },
      history: [],
      ledger: readRequestLedger(current.state),
      policies: new Map(),
    });
    current = commitRequestLedger(current, second.ledger, 3);

    expect(listReadyRequestGroupDeliveries(current.state)).toEqual([
      {
        deliveryKey: 'request-group-completion:["session-turn:0"]',
        ownerCompletion: expect.objectContaining({ owner: "framework-approval-gate" }),
        targets: [{ groupId: "session-turn:0", owner: "framework-approval-gate" }],
      },
      {
        deliveryKey: 'request-group-completion:["session-turn:1"]',
        ownerCompletion: expect.objectContaining({ owner: "session-turn" }),
        targets: [{ groupId: "session-turn:1", owner: "session-turn" }],
      },
    ]);
    expect(openRequestGroups(current.state)).toEqual([]);
    expect(
      readRequestLedger(current.state).requests.every((record) => !isOpenRequest(record)),
    ).toBe(true);
  });

  it("groups mixed owners into one ordered delivery transaction", () => {
    const ledger = {
      groups: [
        {
          completion: {
            deliveryKey: "delivery-1",
            ownerCompletion: {
              messages: [],
              owner: "framework-approval-gate",
              approvedToolKeys: [],
              rejectedActions: [],
            },
            status: "ready" as const,
          },
          id: "session-turn:0",
          owner: "framework-approval-gate" as const,
          requestIds: ["request-1"],
          responseMessages: [],
        },
        {
          completion: {
            deliveryKey: "delivery-1",
            ownerCompletion: { messages: [], owner: "session-turn", limitContinuation: undefined },
            status: "ready" as const,
          },
          id: "session-turn:1",
          owner: "session-turn" as const,
          requestIds: ["request-2"],
          responseMessages: [],
        },
      ],
      requests: [],
      version: 1,
    };

    expect(listReadyRequestGroupDeliveries({ "eve.runtime.hitl.requestLedger": ledger })).toEqual([
      {
        deliveryKey: "delivery-1",
        ownerCompletion: {
          messages: [],
          owner: "framework-approval-gate",
          approvedToolKeys: [],
          rejectedActions: [],
        },
        targets: [
          { groupId: "session-turn:0", owner: "framework-approval-gate" },
          { groupId: "session-turn:1", owner: "session-turn" },
        ],
      },
    ]);
  });

  it("acknowledges one ready delivery idempotently", () => {
    const prepared = session({
      "eve.runtime.hitl.requestLedger": {
        groups: [
          {
            completion: {
              deliveryKey: "delivery-1",
              ownerCompletion: {
                messages: [],
                owner: "session-turn",
                limitContinuation: undefined,
              },
              status: "ready",
            },
            id: "session-turn:0",
            owner: "session-turn",
            requestIds: ["request-1"],
            responseMessages: [],
          },
        ],
        requests: [],
        version: 1,
      },
    });

    const acknowledged = acknowledgeReadyRequestGroupDelivery({
      deliveryKey: "delivery-1",
      session: prepared,
    });
    const idempotent = acknowledgeReadyRequestGroupDelivery({
      deliveryKey: "delivery-1",
      session: acknowledged,
    });

    expect(readRequestLedger(acknowledged.state).groups[0]?.completion).toEqual({
      deliveryKey: "delivery-1",
      status: "delivered",
    });
    expect(idempotent).toBe(acknowledged);
  });

  it("force-closes waiting and ready groups to cancelled and terminalizes open requests including internal authorization", () => {
    const approvalRequest = approval("request-1", "call-1");
    const challenge = {
      attemptId: "authorization-1",
      challenge: { url: "https://example.com" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    };
    const waiting = createRequests({
      authorizations: [{ challenge, responseAttemptId: "request-1:delivery-1" }],
      requests: [],
      responseMessages: [],
      session: createRequests({
        requests: [approvalRequest],
        responseAuthRequiredRequestIds: [approvalRequest.requestId],
        responseMessages: [],
        session: session(),
      }),
    });

    const cancelled = closeRequestLedger(waiting, 2);

    expect(readRequestLedger(cancelled.state)).toMatchObject({
      groups: [{ completion: "cancelled" }],
      requests: [
        { id: "request-1", outcome: { kind: "cancelled", at: 2 } },
        {
          request: { kind: "authorization", requestId: expect.stringContaining("authorization:") },
          outcome: { kind: "cancelled", at: 2 },
        },
      ],
    });
    expect(getPendingAuthorization(cancelled.state)).toBeUndefined();
    expect(listReadyRequestGroupDeliveries(cancelled.state)).toEqual([]);
  });
});
