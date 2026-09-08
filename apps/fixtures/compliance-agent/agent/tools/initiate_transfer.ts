import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import type { Approval } from "eve/tools/approval";
import { z } from "zod";

const TransferInput = z.object({
  recipient_account: z.string(),
  // Amount in the currency's minor unit (e.g. cents for USD, kobo for NGN).
  amount_minor_units: z.number().int().positive(),
  // ISO 4217 currency code.
  currency: z.string().length(3),
  narration: z.string().max(100),
  // Required for schedule / app-principal callers — side-effecting tools must
  // be safely retryable when there is no human in the loop to re-approve.
  idempotency_key: z.string().optional(),
});

type TransferInput = z.output<typeof TransferInput>;

const SUSPICIOUS_NARRATION = /\b(test|dummy|fake|launder|evade)\b/i;
// 1 000 000 minor units = 10 000 in any 2-decimal currency (USD, EUR, NGN…).
const HIGH_VALUE_THRESHOLD = 1_000_000;

/**
 * Deterministic digest of the tool input.
 *
 * Included in the execute output so the audit receipt can prove the input
 * that was approved equals the input that was executed (approval is a gate,
 * not a blank authorisation).
 */
function inputDigest(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const transferApproval: Approval<TransferInput> = (ctx) => {
  // Fail-closed: if we cannot inspect the input we cannot evaluate policy.
  // Return "not-applicable" would pass through silently — we deny instead.
  if (!ctx.toolInput) {
    return {
      type: "denied",
      reason: "Tool input unavailable for policy evaluation — failing closed",
    };
  }

  const { narration, amount_minor_units, idempotency_key } = ctx.toolInput;
  const principal = ctx.session.auth.current;

  // AML narration screen — always applied, regardless of caller type.
  if (SUSPICIOUS_NARRATION.test(narration)) {
    return { type: "denied", reason: "Narration flagged by AML pattern screening" };
  }

  // Schedule / app-principal: no human is present to serve an approval UI.
  // Side-effecting tools are permitted only when the caller supplies an
  // idempotency key that makes retries safe.
  if (principal?.principalType === "runtime" && principal.authenticator === "app") {
    return idempotency_key
      ? { type: "approved" }
      : {
          type: "denied",
          reason: "Schedule calls to financial_transfer require an idempotency_key",
        };
  }

  // High-value threshold — pause for human approval.
  if (amount_minor_units > HIGH_VALUE_THRESHOLD) {
    return { type: "user-approval" };
  }

  // Explicit allow — not the default when policy lookup fails.
  return { type: "approved" };
};

export default defineTool({
  description: "Initiate a funds transfer between accounts.",
  inputSchema: TransferInput,
  approval: transferApproval,
  async execute(input, ctx) {
    const principal = ctx.session.auth.current;
    return {
      reference: `TXN-${input.recipient_account.slice(-6).toUpperCase()}`,
      status: "submitted",
      recipient_account: input.recipient_account,
      amount_minor_units: input.amount_minor_units,
      currency: input.currency,
      narration: input.narration,
      // Adapter contract fields — stable surface for regulated teams.
      side_effect_class: "financial_transfer" as const,
      // Execute re-derives principal from its own ToolContext, not from any
      // closure over the approval-time context. Approval is a gate, not an
      // authorization that carries forward.
      session_principal: principal?.principalType ?? "anonymous",
      input_digest: inputDigest(input as unknown as Record<string, unknown>),
    };
  },
});
