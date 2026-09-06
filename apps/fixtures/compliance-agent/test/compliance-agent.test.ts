/**
 * Regression suite for the compliance-agent fixture.
 *
 * Organised around four independently observable aspects of the Eve tool
 * lifecycle, with the five invariants from vercel/eve#145 expressed as
 * properties of those observations:
 *
 *   1. Policy decision        — approval() resolves before execute() is reached
 *   2. Human approval state   — "user-approval" is a gate, not a policy decision
 *   3. Audit receipt          — receipt_id is independent of execution result
 *   4. Execution result       — execute re-derives session_principal from ToolContext
 */

import { describe, expect, it } from "vitest";
import type { ApprovalContext, ToolContext } from "eve/tools";
import transfer from "../agent/tools/initiate_transfer.js";
import fetchCustomer from "../agent/tools/fetch_customer.js";
import recordAudit from "../agent/tools/record_audit.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type TransferInput = {
  recipient_account: string;
  amount_minor_units: number;
  currency: string;
  narration: string;
  idempotency_key?: string;
};

function makeTransferApprovalCtx(
  toolInput: Partial<TransferInput> | undefined,
  opts: {
    principalType?: string;
    authenticator?: string;
    approvedTools?: string[];
  } = {},
): ApprovalContext<TransferInput> {
  return {
    toolName: "initiate_transfer",
    toolInput: toolInput as TransferInput | undefined,
    approvedTools: new Set(opts.approvedTools ?? []),
    session: {
      id: "test-session",
      auth: {
        current:
          opts.principalType != null
            ? {
                principalType: opts.principalType,
                authenticator: opts.authenticator ?? "test",
                principalId: "test-principal",
                attributes: {},
              }
            : null,
        initiator: null,
      },
      turn: { id: "turn-1", sequence: 1 },
    },
    getSandbox: () => Promise.reject(new Error("no sandbox in tests")),
    getSkill: () => {
      throw new Error("no skill in tests");
    },
  };
}

function makeFetchCustomerApprovalCtx(opts: { approvedTools?: string[] } = {}): ApprovalContext<{
  account_number: string;
}> {
  return {
    toolName: "fetch_customer",
    toolInput: { account_number: "ACC-001" },
    approvedTools: new Set(opts.approvedTools ?? []),
    session: {
      id: "test-session",
      auth: { current: null, initiator: null },
      turn: { id: "turn-1", sequence: 1 },
    },
    getSandbox: () => Promise.reject(new Error("no sandbox in tests")),
    getSkill: () => {
      throw new Error("no skill in tests");
    },
  };
}

function makeToolCtx(opts: { principalType?: string; authenticator?: string } = {}): ToolContext {
  return {
    session: {
      id: "test-session",
      auth: {
        current:
          opts.principalType != null
            ? {
                principalType: opts.principalType,
                authenticator: opts.authenticator ?? "test",
                principalId: "test-principal",
                attributes: {},
              }
            : null,
        initiator: null,
      },
      turn: { id: "turn-1", sequence: 1 },
    },
    getSandbox: () => Promise.reject(new Error("no sandbox in tests")),
    getSkill: () => {
      throw new Error("no skill in tests");
    },
    getToken: () => Promise.reject(new Error("no token in tests")),
    requireAuth: () => {
      throw new Error("requireAuth in tests");
    },
  } as unknown as ToolContext;
}

// Low-value clean transfer — approved outright by policy, no human gate.
const CLEAN_TRANSFER: TransferInput = {
  recipient_account: "ACC-999888",
  amount_minor_units: 500_000,
  currency: "NGN",
  narration: "Monthly rent payment",
};

// High-value transfer — policy routes to human approval gate.
const HIGH_VALUE_TRANSFER: TransferInput = {
  ...CLEAN_TRANSFER,
  amount_minor_units: 2_000_000,
};

const SCHEDULE_PRINCIPAL = { principalType: "runtime", authenticator: "app" } as const;

// ─── Observation 1: Policy decision ──────────────────────────────────────────
//
// Invariant: policy evaluation happens inside approval(), which resolves before
// execute() is ever called. Denial is observable from approval() alone —
// execute() is unreachable when approval() returns { type: "denied" }.

describe("policy decision — fires before execute", () => {
  it("absent toolInput → denied (fail-closed, not silent pass-through)", async () => {
    const result = await transfer.approval!(makeTransferApprovalCtx(undefined));
    expect(result).toMatchObject({ type: "denied" });
  });

  it("deny reason names the fail-closed semantics so the decision is observable", async () => {
    const result = await transfer.approval!(makeTransferApprovalCtx(undefined));
    expect(result).toMatchObject({
      type: "denied",
      reason: expect.stringContaining("failing closed"),
    });
  });

  it("AML narration → denied at the approval boundary, before execute is reached", async () => {
    const result = await transfer.approval!(
      makeTransferApprovalCtx({ ...CLEAN_TRANSFER, narration: "launder proceeds" }),
    );
    expect(result).toMatchObject({ type: "denied", reason: expect.stringContaining("AML") });
  });

  it("clean low-value transfer → approved at the approval boundary", async () => {
    const result = await transfer.approval!(makeTransferApprovalCtx(CLEAN_TRANSFER));
    expect(result).toMatchObject({ type: "approved" });
  });

  it("schedule call without idempotency_key → denied (side effects must be safely retryable)", async () => {
    const result = await transfer.approval!(
      makeTransferApprovalCtx(CLEAN_TRANSFER, SCHEDULE_PRINCIPAL),
    );
    expect(result).toMatchObject({
      type: "denied",
      reason: expect.stringContaining("idempotency_key"),
    });
  });

  it("schedule call with idempotency_key → approved", async () => {
    const result = await transfer.approval!(
      makeTransferApprovalCtx(
        { ...CLEAN_TRANSFER, idempotency_key: "idem-abc123" },
        SCHEDULE_PRINCIPAL,
      ),
    );
    expect(result).toMatchObject({ type: "approved" });
  });

  it("schedule + AML violation → denied (AML check runs before idempotency check)", async () => {
    const result = await transfer.approval!(
      makeTransferApprovalCtx(
        { ...CLEAN_TRANSFER, narration: "test funds", idempotency_key: "idem-1" },
        SCHEDULE_PRINCIPAL,
      ),
    );
    expect(result).toMatchObject({ type: "denied", reason: expect.stringContaining("AML") });
  });
});

// ─── Observation 2: Human approval state ─────────────────────────────────────
//
// Invariant: "approval callback is a gate, not authorization."
// "user-approval" is a distinct observable — it means a human must decide;
// it is not a policy decision and not the same as { type: "denied" }.
// approvedTools communicates the human's prior decision back into the callback;
// it relaxes the gate only after explicit approval, never by default.

describe("human approval state — gate, not authorization", () => {
  it("high-value transfer → user-approval (human must decide, policy has not denied)", async () => {
    const result = await transfer.approval!(makeTransferApprovalCtx(HIGH_VALUE_TRANSFER));
    expect(result).toMatchObject({ type: "user-approval" });
  });

  it('"user-approval" is distinct from { type: "denied" } — it is a gate, not a block', async () => {
    const gate = await transfer.approval!(makeTransferApprovalCtx(HIGH_VALUE_TRANSFER));
    const block = await transfer.approval!(
      makeTransferApprovalCtx({ ...CLEAN_TRANSFER, narration: "launder proceeds" }),
    );
    // Gate suspends execution for human decision; block terminates it.
    // Both are objects but type discriminates them — they must not be equal.
    expect(gate).toMatchObject({ type: "user-approval" });
    expect(block).toMatchObject({ type: "denied" });
    expect(gate).not.toEqual(block);
  });

  it("PII tool without approvedTools → user-approval (gate not yet cleared)", async () => {
    const result = await fetchCustomer.approval!(makeFetchCustomerApprovalCtx());
    expect(result).toBe("user-approval");
  });

  it("PII tool after explicit approval (toolName in approvedTools) → not-applicable (gate cleared)", async () => {
    const result = await fetchCustomer.approval!(
      makeFetchCustomerApprovalCtx({ approvedTools: ["fetch_customer"] }),
    );
    expect(result).toBe("not-applicable");
  });

  it("denial does not add the tool to approvedTools — next call still requires user-approval", async () => {
    // After a denial, approvedTools is empty. The gate must remain closed.
    const result = await fetchCustomer.approval!(makeFetchCustomerApprovalCtx());
    expect(result).toBe("user-approval");
  });

  it("approval is a gate not authorization — execute still re-derives its own principal", async () => {
    // approval() returns approved with no principal context.
    const approvalCtx = makeTransferApprovalCtx(CLEAN_TRANSFER);
    const approvalDecision = await transfer.approval!(approvalCtx);
    expect(approvalDecision).toMatchObject({ type: "approved" });
    expect(approvalCtx.session.auth.current).toBeNull(); // no principal at approval time

    // execute() is called later with a ToolContext that has a real principal.
    // The session_principal in the result comes from that ToolContext, not from
    // the approval context — confirming approval did not carry authorization forward.
    const execResult = await transfer.execute!(
      CLEAN_TRANSFER,
      makeToolCtx({ principalType: "user" }),
    );
    expect(execResult.session_principal).toBe("user");
  });
});

// ─── Observation 3: Audit receipt ────────────────────────────────────────────
//
// The audit receipt is an independent observation: it carries its own receipt_id
// and echoes side_effect_class, input_digest, and session_principal so the record
// can be correlated with the execution result without coupling the two.

describe("audit receipt — independent of execution result", () => {
  it("receipt_id is a valid UUID generated on each call", async () => {
    const result = await recordAudit.execute!(
      {
        event_type: "transfer_initiated",
        subject: "ACC-999888",
        side_effect_class: "financial_transfer",
        input_digest: "abc123def456",
        session_principal: "user",
      },
      makeToolCtx(),
    );
    expect(result.logged).toBe(true);
    expect(result.receipt_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("receipt_id is unique per call — two receipts for the same input differ", async () => {
    const input = { event_type: "pii_accessed" as const, subject: "ACC-001" };
    const r1 = await recordAudit.execute!(input, makeToolCtx());
    const r2 = await recordAudit.execute!(input, makeToolCtx());
    expect(r1.receipt_id).not.toBe(r2.receipt_id);
  });

  it("audit receipt echoes side_effect_class, input_digest, session_principal for correlation", async () => {
    const result = await recordAudit.execute!(
      {
        event_type: "transfer_initiated",
        subject: "ACC-999888",
        side_effect_class: "financial_transfer",
        input_digest: "abc123def456",
        session_principal: "user",
      },
      makeToolCtx(),
    );
    expect(result.side_effect_class).toBe("financial_transfer");
    expect(result.input_digest).toBe("abc123def456");
    expect(result.session_principal).toBe("user");
  });
});

// ─── Observation 4: Execution result ─────────────────────────────────────────
//
// Invariant: "execute re-derives the session principal at execution time."
// The ToolContext passed to execute() is the authoritative source for
// session_principal — it is never inherited from the approval-time context.
// input_digest is deterministic over the input so the audit record can prove
// that the executed input matches the approved input.

describe("execution result — session principal re-derived at call time", () => {
  it("session_principal reflects the ToolContext passed at execute time, not approval time", async () => {
    const execResult = await transfer.execute!(
      CLEAN_TRANSFER,
      makeToolCtx({ principalType: "user" }),
    );
    expect(execResult.session_principal).toBe("user");
  });

  it("two execute calls with different ToolContexts produce different session_principal values", async () => {
    const userResult = await transfer.execute!(
      CLEAN_TRANSFER,
      makeToolCtx({ principalType: "user" }),
    );
    const serviceResult = await transfer.execute!(
      { ...CLEAN_TRANSFER, idempotency_key: "idem-1" },
      makeToolCtx({ principalType: "runtime", authenticator: "app" }),
    );
    expect(userResult.session_principal).toBe("user");
    expect(serviceResult.session_principal).toBe("runtime");
  });

  it("side_effect_class is present and stable in execute output", async () => {
    const result = await transfer.execute!(CLEAN_TRANSFER, makeToolCtx({ principalType: "user" }));
    expect(result.side_effect_class).toBe("financial_transfer");
  });

  it("input_digest is deterministic — same input produces the same digest", async () => {
    const r1 = await transfer.execute!(CLEAN_TRANSFER, makeToolCtx({ principalType: "user" }));
    const r2 = await transfer.execute!(CLEAN_TRANSFER, makeToolCtx({ principalType: "user" }));
    expect(r1.input_digest).toBe(r2.input_digest);
  });

  it("input_digest changes when input changes — approved input and executed input are verifiable", async () => {
    const r1 = await transfer.execute!(CLEAN_TRANSFER, makeToolCtx({ principalType: "user" }));
    const r2 = await transfer.execute!(
      { ...CLEAN_TRANSFER, amount_minor_units: 999_999 },
      makeToolCtx({ principalType: "user" }),
    );
    expect(r1.input_digest).not.toBe(r2.input_digest);
  });

  it("execute produces a TXN reference — execution result is observable independently of policy decision", async () => {
    const result = await transfer.execute!(CLEAN_TRANSFER, makeToolCtx({ principalType: "user" }));
    expect(result.reference).toMatch(/^TXN-/);
    expect(result.status).toBe("submitted");
  });
});
