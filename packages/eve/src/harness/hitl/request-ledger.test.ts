import { describe, expect, it } from "vitest";

import {
  acknowledgeReadyRequestGroupDelivery,
  cancelIncompleteRequestGroups,
  classifyRequestResponse,
  createRequestGroup,
  listReadyRequestGroupDeliveries,
  openRequestGroups,
  prepareReadyRequestGroupDeliveries,
  readRequestLedger,
  RequestLedgerConflictError,
  writePendingAuthorizationState,
  writeRequestLedger,
} from "#harness/hitl/request-ledger.js";
import {
  appendPendingInputBatch,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
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
      requests: [{ id: "request-1", state: "open" }],
      version: 0,
    });
    expect(legacy.state).toHaveProperty("eve.runtime.pendingInputBatch");
  });

  it("writes the ledger and removes legacy batch keys on first mutation", () => {
    const legacy = session({
      "eve.runtime.pendingInputBatch": { requests: [request], responseMessages: [] },
    });
    const ledger = readRequestLedger(legacy.state);
    const migrated = writeRequestLedger({
      expectedVersion: ledger.version,
      groups: ledger.groups,
      requests: ledger.requests,
      session: legacy,
    });

    expect(migrated.state).not.toHaveProperty("eve.runtime.pendingInputBatch");
    expect(readRequestLedger(migrated.state).version).toBe(1);
  });

  it("rejects a stale conditional write", () => {
    const created = createRequestGroup({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    const ledger = readRequestLedger(created.state);

    expect(() =>
      writeRequestLedger({
        expectedVersion: ledger.version - 1,
        groups: ledger.groups,
        requests: ledger.requests,
        session: created,
      }),
    ).toThrow(RequestLedgerConflictError);
  });

  it("distinguishes open, stale, and invalid responses", () => {
    const created = appendPendingInputBatch({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    expect(classifyRequestResponse(created.state, "request-1")).toBe("open");
    expect(classifyRequestResponse(created.state, "unknown")).toBe("invalid");

    const batch = openRequestGroups(created.state)[0];
    if (batch === undefined) throw new Error("Expected an open request group.");
    const delivered = removePendingInputBatches(created, [batch]);
    expect(classifyRequestResponse(delivered.state, "request-1")).toBe("stale");
  });

  it("retains terminal requests after a group is delivered", () => {
    const created = appendPendingInputBatch({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    const batch = openRequestGroups(created.state)[0];
    if (batch === undefined) throw new Error("Expected an open request group.");
    const delivered = removePendingInputBatches(created, [batch]);

    expect(openRequestGroups(delivered.state)).toEqual([]);
    expect(readRequestLedger(delivered.state)).toMatchObject({
      groups: [{ completion: { deliveryKey: "legacy:session-turn:0", status: "delivered" } }],
      requests: [{ id: "request-1", state: "terminal" }],
    });
  });
});

describe("request ledger extension migration", () => {
  it("reads legacy approval-attempt state and removes its key on write", async () => {
    const { getApprovalAuditState, settleDirectApprovalResponse } =
      await import("#harness/hitl/approval-response-attempts.js");
    const actor = {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    };
    const legacy = {
      "eve.runtime.hitl.approvalState": {
        activeCandidates: {},
        candidateHistory: [],
        nextCandidateSequence: 0,
        settlements: {},
      },
    };
    expect(getApprovalAuditState(legacy).settlements).toEqual([]);

    const settled = settleDirectApprovalResponse({
      actor,
      outcome: "allowed",
      requestId: "request-1",
      settledAt: 1,
      state: legacy,
    });
    expect(settled.state).not.toHaveProperty("eve.runtime.hitl.approvalState");
    expect(getApprovalAuditState(settled.state).settlements).toHaveLength(1);
  });

  it("reads legacy Authorization state and removes its key on write", async () => {
    const { getPendingAuthorization, setPendingAuthorization } =
      await import("#harness/authorization.js");
    const challenge = {
      challenge: { url: "https://example.com" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    } as const;
    const legacy = { "eve.runtime.pendingAuthorization": { challenges: [challenge] } };
    expect(getPendingAuthorization(legacy)?.challenges).toEqual([challenge]);

    const migrated = setPendingAuthorization(legacy, { challenges: [challenge] });
    expect(migrated).not.toHaveProperty("eve.runtime.pendingAuthorization");
    expect(getPendingAuthorization(migrated)?.challenges).toEqual([challenge]);
    expect(readRequestLedger(migrated).requests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          authorization: challenge,
          kind: "authorization",
        }),
        state: "open",
      }),
    );
    expect(openRequestGroups(migrated)).toEqual([]);
  });

  it("retains completed Authorization requests as terminal records", async () => {
    const { clearPendingAuthorization, setPendingAuthorization } =
      await import("#harness/authorization.js");
    const challenge = {
      attemptId: "authorization-1",
      challenge: { url: "https://example.com" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    } as const;
    const opened = setPendingAuthorization(undefined, { challenges: [challenge] });
    const completed = clearPendingAuthorization(opened, ["authorization-1"]);

    expect(readRequestLedger(completed).requests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ kind: "authorization" }),
        state: "terminal",
      }),
    );
  });
});

describe("request group owners", () => {
  it("stores the framework approval gate as the owner of an approval group", () => {
    const approval: InputRequest = {
      action: { callId: "call-approval", input: {}, kind: "tool-call", toolName: "bash" },
      kind: "tool-approval",
      prompt: "Approve bash",
      requestId: "approval-1",
    };
    const created = createRequestGroup({
      owner: "framework-approval-gate",
      requests: [approval],
      responseMessages: [],
      session: session(),
    });

    expect(readRequestLedger(created.state).groups[0]?.owner).toBe("framework-approval-gate");
  });

  it("defaults non-gate groups to the session-turn owner", () => {
    const created = createRequestGroup({
      requests: [request],
      responseMessages: [],
      session: session(),
    });

    expect(readRequestLedger(created.state).groups[0]?.owner).toBe("session-turn");
  });
});

describe("request group completion delivery", () => {
  it("prepares resolved groups as ready, terminalizes their public requests, and lists deliveries in group order", () => {
    const request2: InputRequest = {
      action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "ask_question" },
      kind: "question",
      prompt: "Second?",
      requestId: "request-2",
    };
    const created = createRequestGroup({
      requests: [request],
      responseMessages: [],
      session: createRequestGroup({
        owner: "framework-approval-gate",
        requests: [request2],
        responseMessages: [],
        session: session(),
      }),
    });

    const prepared = prepareReadyRequestGroupDeliveries({
      ownerCompletions: new Map([
        ["session-turn:0", { deliveryKey: "delivery-1", ownerCompletion: { ok: 1 } }],
        ["session-turn:1", { deliveryKey: "delivery-2", ownerCompletion: ["opaque"] }],
      ]),
      session: created,
    });

    expect(listReadyRequestGroupDeliveries(prepared.state)).toEqual([
      {
        deliveryKey: "delivery-1",
        groupId: "session-turn:0",
        owner: "framework-approval-gate",
        ownerCompletion: { ok: 1 },
      },
      {
        deliveryKey: "delivery-2",
        groupId: "session-turn:1",
        owner: "session-turn",
        ownerCompletion: ["opaque"],
      },
    ]);
    expect(openRequestGroups(prepared.state)).toEqual([]);
    expect(readRequestLedger(prepared.state).requests).toEqual([
      expect.objectContaining({ id: "request-2", state: "terminal" }),
      expect.objectContaining({ id: "request-1", state: "terminal" }),
    ]);
  });

  it("acknowledges one ready delivery idempotently", () => {
    const created = createRequestGroup({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    const prepared = prepareReadyRequestGroupDeliveries({
      ownerCompletions: new Map([
        ["session-turn:0", { deliveryKey: "delivery-1", ownerCompletion: { ok: true } }],
      ]),
      session: created,
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
    const challenge = {
      attemptId: "authorization-1",
      challenge: { url: "https://example.com" },
      hookUrl: "https://example.com/callback",
      name: "linear",
    } as const;
    const waiting = createRequestGroup({
      requests: [request],
      responseMessages: [],
      session: session(),
    });
    const withAuthorization = {
      ...waiting,
      state: writePendingAuthorizationState(waiting.state, [
        { challenge, responseAttemptId: "authorization-1" },
      ]),
    };
    const ready = prepareReadyRequestGroupDeliveries({
      ownerCompletions: new Map([
        ["session-turn:0", { deliveryKey: "delivery-1", ownerCompletion: { ok: true } }],
      ]),
      session: withAuthorization,
    });

    const cancelled = cancelIncompleteRequestGroups(ready);

    expect(readRequestLedger(cancelled.state)).toMatchObject({
      groups: [{ completion: "cancelled" }],
      requests: [
        { id: "request-1", state: "terminal" },
        {
          request: { kind: "authorization", requestId: expect.stringContaining("authorization:") },
          state: "terminal",
        },
      ],
    });
    expect(listReadyRequestGroupDeliveries(cancelled.state)).toEqual([]);
  });
});
