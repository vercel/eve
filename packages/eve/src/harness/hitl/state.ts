import type { SessionView } from "#harness/session-machine/view.js";
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { ApprovalAudit } from "#harness/session-machine/view.js";

import type { Command } from "./command.js";
import type { RelayRoute, RequestAt } from "./input.js";

// ---------------------------------------------------------------------------
// Read-only rule projection; the session machine owns persisted execution state.
// ---------------------------------------------------------------------------

/** What a rule leaves: the state, and the events it reports, in order. */
export interface Reduced<S = SessionView> {
  readonly events: readonly Command[];
  readonly state: S;
}

/** Exported only for the rules files beside this one. */
export interface HumanInputState {
  /** Every open request, by `requestId`. */
  readonly requests: Readonly<Record<string, OpenRequest>>;
  /** Turn input that waited behind a step's calls, for the turn's next step to read. */
  readonly queued?: StepInput;
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
  /** The model step whose calls wait, held out of history. */
  readonly held?: HeldStep;
  /** Every response-policy candidate and settlement of the session. */
  readonly audit?: ApprovalAudit;
  /** Authorizations children and runs started through this session, by attempt id, until they complete. */
  readonly relayedAuthorizations?: Readonly<Record<string, RelayedAuthorization>>;
}

type OpenRequest =
  | OpenApproval
  | OpenAuthorization
  | { readonly kind: "session-limit"; readonly at: RequestAt; readonly request: InputRequest }
  | OpenRelayed;

const EMPTY: HumanInputState = { grants: [], requests: {} };

/**
 * The state stored under the session key, as stored. `readState`
 * (`session-machine/migrate-legacy.ts`) upgrades what earlier releases stored.
 */
export function parseState(value: unknown): HumanInputState {
  if (typeof value !== "object" || value === null) return EMPTY;
  const requests: unknown = Reflect.get(value, "requests");
  const grants: unknown = Reflect.get(value, "grants");
  if (typeof requests !== "object" || requests === null || !Array.isArray(grants)) return EMPTY;
  return value as HumanInputState;
}

// ---------------------------------------------------------------------------
// What each kind of request keeps open
// ---------------------------------------------------------------------------

/** An open approval, as the session stores it. */
export interface OpenApproval {
  readonly kind: "tool-approval";
  readonly at: RequestAt;
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
  readonly at: RequestAt;
  readonly challenge: AuthorizationChallenge;
}

/** A model step held out of history until every call it made has a result. */
export interface HeldStep {
  readonly at: RequestAt;
  /** The step's response and the results it has so far. */
  readonly messages: readonly ModelMessage[];
  /**
   * Set once some of its calls run as runtime work: the workflow runs they
   * start. Its task tool calls run there too; the session answers them.
   */
  readonly runtime?: {
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    readonly approvers?: Readonly<Record<string, SessionAuthContext>>;
  };
  /**
   * Calls a person approved that haven't run yet. The turn runs them
   * (`approvedCalls`) before it reads anything else.
   */
  readonly approved?: readonly InputRequest[];
  /** Turn input that arrived while its calls waited, read after their results. */
  readonly following?: StepInput;
}

/** A relayed request, as the session stores it until it is answered or withdrawn. */
export interface OpenRelayed {
  readonly kind: "relayed";
  /** The coordinates of the child batch's `input.requested`, which its `input.resolved` repeats. */
  readonly at: RequestAt;
  readonly request: InputRequest;
  readonly route: RelayRoute;
}

/** An authorization a child or run started through this session, recorded until it completes. */
export interface RelayedAuthorization {
  readonly at: RequestAt;
  readonly name: string;
  readonly runId: string;
}

export type {
  ActiveCandidate,
  ApprovalAudit,
  FinishedCandidate,
  ResponderIdentity,
  Settlement,
} from "#harness/session-machine/view.js";
export const EMPTY_AUDIT: ApprovalAudit = {
  activeCandidates: {},
  candidateHistory: [],
  nextCandidateSequence: 0,
  settlements: {},
};

export function isOpenRelayed(value: { readonly kind: string } | undefined): value is OpenRelayed {
  return value?.kind === "relayed";
}
