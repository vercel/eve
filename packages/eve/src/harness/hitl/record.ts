import type { SessionView } from "#harness/session-machine/view.js";
import type { Command } from "./command.js";
import type { InputRequest } from "#shared/input.js";
import type { InputResponse } from "#shared/input.js";
import type { StepCoordinates } from "#harness/session-machine/view.js";
import type { InputOption } from "#shared/input.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { ApprovalCandidateOutcome } from "#protocol/message.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";

export type CandidateDecision = "approve" | "cancel";

/** Where a relayed request's answer goes. */
export interface RelayRoute {
  /** The child's continuation token, which names its session inbox unless `childSessionInbox` does. */
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** A remote agent's session, answered over its own protocol. */
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  /** Where in the child the batch came from; its fresh batch from one source replaces the last. */
  readonly inputSource?: string;
  /** The workflow run that relayed it: nobody can answer it once that run ends. */
  readonly runId?: string;
  /** The run's control hook, for its own `ctx.ask()` question. */
  readonly control?: string;
}

/** A candidate waiting on its policy, or on its responder's authorization. */
export interface ActiveCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  /** The authorizations its policy waits on, while `authorization-required`. */
  readonly authorizations?: readonly AuthorizationChallenge[];
}

/** Who answered, narrowed to identity for the audit's finished records. */
export interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export interface FinishedCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly reason?: string;
  readonly requestId: string;
  readonly responder: ResponderIdentity;
  readonly status: "allowed" | Exclude<ApprovalCandidateOutcome, "pending">;
}

/** An approval a signed-in person settled: through a candidate, or directly. */
export interface Settlement {
  readonly actor: ResponderIdentity;
  /** The full auth of the approver, absent for cancellations. */
  readonly approver?: SessionAuthContext;
  readonly candidateId?: string;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
}

/** The durable candidate audit, kept in the session machine's execution state. */
export interface ApprovalAudit {
  readonly activeCandidates: Readonly<Record<string, ActiveCandidate>>;
  readonly candidateHistory: readonly FinishedCandidate[];
  readonly nextCandidateSequence: number;
  readonly settlements: Readonly<Record<string, Settlement>>;
}

/**
 * Marks a request as a workflow tool run's `ctx.ask()` question, rather than a
 * child session's. Its answer goes to the run's control hook, which carries
 * every decision the session makes for the run, in order.
 */
export interface WorkflowAskRoute {
  readonly control: string;
  /** What a plain-text message may answer. */
  readonly question: ProxyInputQuestion;
}

/** The parts of a `ctx.ask()` request a plain-text message is resolved against. */
export interface ProxyInputQuestion {
  readonly allowFreeform?: boolean;
  readonly options?: readonly InputOption[];
}

/** Data owned by human-input rules, not by the session projection or execution machine. */
export interface HitlRecord {
  readonly steps?: Readonly<
    Record<
      string,
      {
        readonly answers: Readonly<Record<string, InputResponse>>;
        readonly approvalKeys: Readonly<Record<string, string>>;
      }
    >
  >;
  readonly audit?: ApprovalAudit;
  readonly relayedRoutes?: Readonly<Record<string, RelayRoute>>;
  readonly relayedAuthorizations?: Readonly<
    Record<
      string,
      {
        readonly at: StepCoordinates;
        readonly name: string;
        readonly runId: string;
      }
    >
  >;
  /** Person-gated results joined history; arrivals wait for the next model response. */
  readonly readsResults?: true;
}

/** Failure and cancellation remove transient human-input execution bookkeeping. */
export function cleanupHitl(record: HitlRecord | undefined): HitlRecord | undefined {
  return record === undefined ? undefined : { ...record, readsResults: undefined };
}

/** Empty bookkeeping should not keep an otherwise idle turn checkpoint alive. */
export function hasHitlRecord(record: HitlRecord | undefined): boolean {
  return (
    record?.audit !== undefined ||
    record?.readsResults === true ||
    Object.keys(record?.relayedRoutes ?? {}).length > 0 ||
    Object.keys(record?.relayedAuthorizations ?? {}).length > 0 ||
    Object.keys(record?.steps ?? {}).length > 0
  );
}

/** Coordinates, not call ids, identify an originating step. */
export function hitlStepKey(at: StepCoordinates): string {
  return JSON.stringify([at.turnId, at.sequence, at.stepIndex]);
}

/** What a rule leaves: the state, and the events it reports, in order. */
export interface Reduced<S = SessionView> {
  readonly events: readonly Command[];
  readonly state: S;
}

/** An open approval, as the session stores it. */
export interface OpenApproval {
  readonly kind: "tool-approval";
  readonly at: StepCoordinates;
  readonly request: InputRequest;
  readonly requester: SessionAuthContext | null;
  /** What a `once()` approval grants: the tool's approval key, else its name. */
  readonly approvalKey: string;
  /** An answer that arrived before the rest of the step's approvals were answered. */
  readonly answer?: InputResponse;
  /** Its tool's `approval.response` policy decides who may answer (see candidates). */
  readonly responsePolicy?: true;
}

/** An open authorization, as the session stores it. */
export interface OpenAuthorization {
  readonly kind: "authorization";
  readonly at: StepCoordinates;
  readonly challenge: AuthorizationChallenge;
}

/** A relayed request, as the session stores it until it is answered or withdrawn. */
export interface OpenRelayed {
  readonly kind: "relayed";
  /** The coordinates of the child batch's `input.requested`, which its `input.resolved` repeats. */
  readonly at: StepCoordinates;
  readonly request: InputRequest;
  readonly route: RelayRoute;
}

export const EMPTY_AUDIT: ApprovalAudit = {
  activeCandidates: {},
  candidateHistory: [],
  nextCandidateSequence: 0,
  settlements: {},
};
