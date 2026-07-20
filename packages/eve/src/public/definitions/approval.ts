import type { SessionContext } from "#public/definitions/callback-context.js";

type ApprovalToolInput<TInput> = TInput extends object ? Readonly<TInput> : TInput;

/**
 * Context passed to an {@link Approval} function.
 *
 * Extends {@link SessionContext} so approval policies can make decisions from
 * the active session, current caller, and turn.
 *
 * `approvedTools` is the set of tool names (or compound approval keys)
 * already approved at least once in the current session. `toolName` is the
 * runtime name of the tool being evaluated. `toolInput` is the raw input the
 * model passed, available for input-aware decisions. `callId` is the id of
 * the call being evaluated — the same `callId` carried by the call's stream
 * events and its `execute` context.
 */
export interface ApprovalContext<TInput = Record<string, unknown>> extends SessionContext {
  readonly approvedTools: ReadonlySet<string>;
  readonly callId: string;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

/**
 * Approval decision returned by an {@link Approval} function.
 *
 * AI SDK 7 statuses are accepted directly. For compatibility, `true` maps to
 * `"user-approval"` and `false` maps to `"not-applicable"`.
 */
export type ApprovalStatus =
  | undefined
  | boolean
  | "not-applicable"
  | "approved"
  | "denied"
  | "user-approval"
  | { readonly type: "not-applicable"; readonly reason?: never }
  | { readonly type: "approved"; readonly reason?: string }
  | { readonly type: "denied"; readonly reason?: string }
  | { readonly type: "user-approval"; readonly reason?: never };

/** Shared approval policy used by authored tools and connections. */
export type Approval<TInput = Record<string, unknown>> = (
  ctx: ApprovalContext<TInput>,
) => ApprovalStatus | Promise<ApprovalStatus>;
