/**
 * Structural copies of the real harness types the prototype compiles
 * against, so the prototype typechecks standalone. Source of truth:
 *
 *   InputRequest / InputResponse      packages/eve/src/shared/input.ts
 *   PendingInputBatch                 packages/eve/src/harness/pending-input-batches.ts
 *   ResolvePendingInputResult         packages/eve/src/harness/hitl/pending-input-resolution.ts
 *   SessionAuthContext                packages/eve/src/channel/types.ts
 *   ApprovalResponseDecision          packages/eve/src/public/definitions/approval.ts
 *
 * When promoted into the package these imports become the real modules; the
 * shapes here are field-for-field subsets, deviations called out inline.
 */

export interface InputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style?: "primary" | "danger" | "default";
}

export interface InputRequest {
  readonly action: { readonly callId: string; readonly toolName: string; readonly input: Record<string, unknown>; readonly kind: "tool-call" };
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly kind: "question" | "session-limit" | "tool-approval";
  readonly options?: readonly InputOption[];
  readonly prompt: string;
  readonly requestId: string;
}

/**
 * Deviation: today's wire InputResponse is {requestId, optionId?, text?}.
 * The interpreter needs the verified responder and actor relation as DATA (they
 * are guard axes). Today they ride beside the response
 * (attributedInputResponses on StepInput); the prototype folds them in.
 */
export interface InputResponse {
  readonly requestId: string;
  readonly optionId?: string;
  readonly text?: string;
  readonly responder?: SessionAuthContext | null;
  readonly actor?: "originating" | "other" | "anonymous";
}

export interface SessionAuthContext {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly subject?: string;
}

export type ApprovalResponseDecision =
  | { readonly status: "allowed" }
  | { readonly reason: string; readonly status: "rejected" };

export interface PendingInputBatchEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface PendingInputBatch {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly responseMessages: readonly ModelMessage[];
}

export type ModelMessage = { readonly role: string; readonly content: unknown };

export type SessionStateMap = Record<string, unknown>;

export interface HarnessSession {
  readonly history: readonly ModelMessage[];
  readonly state?: SessionStateMap;
}

export interface StepInput {
  readonly message?: string;
  readonly inputResponses?: readonly InputResponse[];
  readonly context?: readonly unknown[];
  readonly outputSchema?: unknown;
}

export type HarnessToolMap = Record<string, unknown>;

export interface ResolvePendingInputResult {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  readonly limitContinuation?: { readonly granted: boolean };
  readonly outcome: "resolved" | "continue" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly unknown[];
  readonly resolvedInputs?: readonly unknown[];
  readonly session: HarnessSession;
}
