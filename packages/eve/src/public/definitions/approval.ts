type ApprovalToolInput<TInput> = TInput extends object ? Readonly<TInput> : TInput;

/**
 * Context passed to an {@link Approval} function.
 *
 * `approvedTools` is the set of tool names (or compound approval keys)
 * already approved at least once in the current session. `toolName` is the
 * runtime name of the tool being evaluated. `toolInput` is the raw input the
 * model passed, available for input-aware decisions.
 */
export interface ApprovalContext<TInput = Record<string, unknown>> {
  readonly approvedTools: ReadonlySet<string>;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

/**
 * Approval decision returned by an {@link Approval} function.
 *
 * These statuses mirror AI SDK 7's call-level tool approval contract while
 * keeping eve's public API independent of AI SDK types.
 */
export type ApprovalStatus =
  | undefined
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
