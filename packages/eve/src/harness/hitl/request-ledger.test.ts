import { describe, expect, it } from "vitest";

import {
  classifyRequestResponse,
  createRequestGroup,
  openRequestGroups,
  readRequestLedger,
  RequestLedgerConflictError,
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
      groups: [{ completion: "delivered" }],
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
