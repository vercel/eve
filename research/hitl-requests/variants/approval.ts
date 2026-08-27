/**
 * Approval variant: human consent for one tool call.
 *
 * ## Dynamic and ephemeral approval policies
 *
 * Approval semantics are per-tool and per-call — `defineTool.approval` is
 * authored code, and dynamic tools (`defineDynamic`) exist only in the steps
 * that advertised them. A policy function therefore CANNOT be persisted with
 * the row. The spec stores only durable facts, and the policy is late-bound
 * at every interpretation pass:
 *
 *   park time     spec records { action, intentKey, responseAuthRequired }
 *                 — intentKey is the computed approvalKey(toolInput) string;
 *                 responseAuthRequired records "this tool HAD a response
 *                 policy when it asked", today's
 *                 `PendingInputBatch.responseAuthRequiredRequestIds`.
 *
 *   response time  the caller re-resolves toolName → policy from the live
 *                 HarnessToolMap (`bindApprovalPolicy`), the same lookup
 *                 `authorizeCandidate` does today
 *                 (approval-delivery-coordinator.ts:334). The reducer sees
 *                 the result as `spec.responsePolicy`, possibly undefined.
 *
 * The undefined case is where ephemerality bites, and the rule is recorded
 * at park time so the reducer can decide without the registry:
 *
 *   responseAuthRequired = false  → no response policy ever existed; a
 *     correlated allow/deny settles directly (today's
 *     `settleDirectApprovalResponse`). A vanished dynamic tool with no
 *     response policy still settles — the request was already fully
 *     specified when raised, and execution of the underlying call is the
 *     group continuation's problem (it rechecks tool existence at dispatch,
 *     failing the CALL, not the consent).
 *
 *   responseAuthRequired = true, policy unavailable → fail closed, row
 *     stays open: reject policy-failed (today's failCandidate "Approval
 *     authorization is temporarily unavailable"). A redeploy restoring the
 *     tool makes the same row answerable again — the row outlives the
 *     policy's availability, never the other way around.
 */

import type {
  ApprovalResponseDecision,
  InputRequest,
  SessionAuthContext,
} from "../harness-types.js";
import type { Row, Variant, Verdict } from "../types.js";

export interface ApprovalSpec {
  /** The gated tool call: { toolName, callId, input }. Durable. */
  readonly request: InputRequest;
  /** Recorded at park time: the tool had a response policy when it asked. */
  readonly responseAuthRequired: boolean;
  /** Authored approvalKey(toolInput), computed at raise time. Durable. */
  readonly intentKey?: string;
  /**
   * Late-bound, never persisted: re-resolved from the live HarnessToolMap
   * by the caller on every pass. Undefined when the tool is currently absent
   * (ephemeral dynamic tool, redeploy) or authored no response policy.
   */
  readonly responsePolicy?: ApprovalResponsePolicy;
}

export type ApprovalPolicyResult =
  | ApprovalResponseDecision
  | { readonly status: "needs-auth"; readonly challenge: unknown };

export type ApprovalResponsePolicy = (input: {
  readonly responder: SessionAuthContext | null;
  readonly request: InputRequest;
}) => Promise<ApprovalPolicyResult>;

export type ApprovalOutcome = "allowed" | "denied" | "cancelled";

export const approval: Variant<ApprovalSpec, ApprovalOutcome> = {
  intentKey: (spec) => spec.intentKey,

  async resolve(row, input): Promise<Verdict<ApprovalOutcome>> {
    if (input.kind === "linked") {
      // The sign-in this candidate was blocked on completed.
      return input.outcome === "authorized"
        ? runResponsePolicy(row, input.heldResponse.optionId, input.heldResponse.responder ?? null)
        : { reject: input.outcome === "declined" ? "unauthorized" : "policy-failed" };
    }

    if (input.kind !== "response") return "ignore"; // text never settles an approval

    const option = input.response.optionId;
    if (option !== "allow" && option !== "deny" && option !== "cancel")
      return { reject: "invalid" };

    if (option === "cancel")
      // Authenticated cancel bypasses the allow-authorizer.
      return input.responder !== null ? { settle: "cancelled" } : { reject: "unauthorized" };

    return runResponsePolicy(row, option, input.responder);
  },
};

async function runResponsePolicy(
  row: Row<ApprovalSpec>,
  option: string | undefined,
  responder: SessionAuthContext | null,
): Promise<Verdict<ApprovalOutcome>> {
  const outcome: ApprovalOutcome = option === "allow" ? "allowed" : "denied";

  if (row.spec.responsePolicy === undefined) {
    // Ephemerality rule: settle when no policy was ever required; fail
    // closed (row stays open) when one was required but is unavailable now.
    return row.spec.responseAuthRequired ? { reject: "policy-failed" } : { settle: outcome };
  }

  // Policy throw/timeout → policy-failed, row stays open: the interpreter
  // wraps this call (handleApprovalResponsePolicyError semantics move there).
  const decision = await row.spec.responsePolicy({ responder, request: row.spec.request });
  if (decision.status === "rejected") return { reject: "unauthorized" };
  if (decision.status === "needs-auth") return { blockOn: decision.challenge };
  return { settle: outcome };
}
