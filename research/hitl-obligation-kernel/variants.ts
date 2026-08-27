/**
 * The four variant reducers against real harness shapes.
 *
 * The approval variant is the answer to "approvals are dynamic, per-tool":
 * the reducer owns no policy. It receives the RESOLVED policy surface for
 * its row — the same per-tool authored `Approval` that
 * `approval-delivery-coordinator.ts` resolves from `HarnessToolMap` today
 * (`tool.approval.response`, `buildApprovalResponseAuth`,
 * `handleApprovalResponsePolicyError`). Dynamic-ness lives where it lives
 * now: the spec carries the tool name; the seam resolves name → policy at
 * interpretation time, exactly like `resolveApprovalKeyFromTools` does.
 */

import type {
  ApprovalResponseDecision,
  InputRequest,
  SessionAuthContext,
} from "./harness-types.js";
import type { Row, RowInput, Variant, Verdict } from "./types.js";

// ---------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------

export interface ApprovalSpec {
  readonly request: InputRequest; // kind: "tool-approval"; carries action {toolName, callId, input}
  readonly responseAuthRequired: boolean;
  /** Authored approvalKey(toolInput), resolved from the tool at raise time. */
  readonly intentKey?: string;
  /**
   * The tool's resolved response policy. Injected per-row by the seam from
   * the live HarnessToolMap — the reducer never touches the tool registry,
   * which is what keeps per-tool dynamic approval semantics out of the
   * kernel. Absent policy = accept any responder (today's default).
   */
  readonly responsePolicy?: (input: {
    readonly responder: SessionAuthContext | null;
    readonly request: InputRequest;
  }) => Promise<ApprovalResponseDecision | { readonly status: "needs-auth"; readonly challenge: unknown }>;
}

export type ApprovalOutcome = "allowed" | "denied" | "cancelled";

export const approval: Variant<ApprovalSpec, ApprovalOutcome> = {
  intentKey: (spec) => spec.intentKey,

  async resolve(row, input): Promise<Verdict<ApprovalOutcome>> {
    if (input.kind === "linked") {
      // The sign-in this candidate was blocked on completed.
      return input.outcome === "authorized"
        ? adjudicate(row, input.heldResponse.optionId, responderOf(input.heldResponse))
        : { reject: input.outcome === "declined" ? "unauthorized" : "policy-failed" };
    }

    if (input.kind !== "response") return "ignore"; // text never settles an approval

    const option = input.response.optionId;
    if (option !== "allow" && option !== "deny" && option !== "cancel")
      return { reject: "invalid" };

    if (option === "cancel")
      // Authenticated cancel bypasses the allow-authorizer.
      return input.responder !== null ? { settle: "cancelled" } : { reject: "unauthorized" };

    return adjudicate(row, option, input.responder);
  },
};

async function adjudicate(
  row: Row<ApprovalSpec>,
  option: string | undefined,
  responder: SessionAuthContext | null,
): Promise<Verdict<ApprovalOutcome>> {
  const outcome: ApprovalOutcome = option === "allow" ? "allowed" : "denied";
  if (row.spec.responsePolicy === undefined) return { settle: outcome };

  // Policy throw/timeout → policy-failed, row stays open: the kernel wraps
  // this call (handleApprovalResponsePolicyError semantics move there).
  const decision = await row.spec.responsePolicy({ responder, request: row.spec.request });
  if (decision.status === "rejected") return { reject: "unauthorized" };
  if (decision.status === "needs-auth") return { blockOn: decision.challenge };
  return { settle: outcome };
}

function responderOf(response: { readonly responder?: SessionAuthContext | null }) {
  return response.responder ?? null;
}

// ---------------------------------------------------------------------------
// question
// ---------------------------------------------------------------------------

export interface QuestionSpec {
  readonly request: InputRequest; // kind: "question"; options, allowFreeform
  readonly supersedable: boolean;
}

export type QuestionOutcome =
  | { readonly status: "answered"; readonly optionId?: string; readonly text?: string }
  | { readonly status: "ignored" };

export const question: Variant<QuestionSpec, QuestionOutcome> = {
  resolve(row, input): Verdict<QuestionOutcome> {
    switch (input.kind) {
      case "response": {
        const { optionId, text } = input.response;
        const options = row.spec.request.options;
        if (optionId !== undefined && !options?.some((option) => option.id === optionId))
          return { reject: "invalid" };
        if (optionId === undefined && text !== undefined && row.spec.request.allowFreeform !== true)
          return { reject: "invalid" };
        return { settle: { status: "answered", optionId, text } };
      }
      case "message":
        return input.actor === "originating" && row.spec.supersedable
          ? { dismiss: "superseded" }
          : "ignore";
      default:
        return "ignore";
    }
  },
};

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

export interface LimitSpec {
  readonly request: InputRequest; // kind: "session-limit"
  readonly generation: number;
}

export type LimitOutcome = "continued" | "stopped";

export const limit: Variant<LimitSpec, LimitOutcome> = {
  staleResponses: "drop", // stale limit answers must never reach the model

  resolve(row, input): Verdict<LimitOutcome> {
    switch (input.kind) {
      case "response":
        return {
          settle: input.response.optionId === "continue" ? "continued" : "stopped",
        };
      case "message":
        // The one licensed irregularity: consume the message, reopen fresh.
        return {
          dismiss: "superseded",
          reopen: { ...row.spec, generation: row.spec.generation + 1 },
          consumeDelivery: true,
        };
      default:
        return "ignore";
    }
  },
};

// ---------------------------------------------------------------------------
// challenge
// ---------------------------------------------------------------------------

export interface ChallengeSpec {
  readonly name: string; // connection name
  readonly attemptId: string;
  readonly deadlineAt?: number; // kernel schedules the deadline input
}

export type ChallengeOutcome = "authorized" | "declined" | "failed" | "timed-out";

export const challenge: Variant<ChallengeSpec, ChallengeOutcome> = {
  resolve(row, input): Verdict<ChallengeOutcome> {
    switch (input.kind) {
      case "callback": {
        const outcome = input.params["outcome"];
        return {
          settle:
            outcome === "authorized" || outcome === "declined" ? outcome : "failed",
        };
      }
      case "deadline":
        return { settle: "timed-out" };
      default:
        return "ignore"; // messages never touch an open challenge
    }
  },
};

export const variants = { approval, question, limit, challenge };
