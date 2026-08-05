import type { SessionAuthContext } from "#channel/types.js";
import type { SessionParent, SessionTurn } from "#context/keys.js";
import type { ToolAuthOptions, ToolAuthProvider } from "#public/definitions/tool.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { TokenResult } from "#runtime/connections/types.js";

type ApprovalToolInput<TInput> = TInput extends object ? Readonly<TInput> : TInput;

/**
 * Context passed to an {@link ApprovalPolicy} function.
 *
 * Extends {@link SessionContext} so approval policies can make decisions from
 * the active session, current caller, and turn.
 */
export interface ApprovalContext<TInput = Record<string, unknown>> extends SessionContext {
  readonly approvedTools: ReadonlySet<string>;
  readonly callId: string;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

/** Request-time approval decision returned by an {@link ApprovalPolicy}. */
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

/** Request-time approval policy shared by authored tools and connections. */
export type ApprovalPolicy<TInput = Record<string, unknown>> = (
  ctx: ApprovalContext<TInput>,
) => ApprovalStatus | Promise<ApprovalStatus>;

/** Stable tool request passed to a response authorizer. */
export interface ApprovalRequest<TInput = Record<string, unknown>> {
  readonly callId: string;
  readonly requestId: string;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

/** Read-only session identity and lineage available to a response authorizer. */
export interface ApprovalResponseSession {
  readonly id: string;
  readonly initiator: SessionAuthContext | null;
  readonly parent?: SessionParent;
  readonly turn: SessionTurn;
}

/** Narrow authorization capability available while validating a responder. */
export interface ApprovalResponseAuth {
  getToken(provider: ToolAuthProvider, options?: ToolAuthOptions): Promise<TokenResult>;
  requireAuth(provider: ToolAuthProvider, options?: ToolAuthOptions): never;
}

/** Submitted decision passed to an approval response policy. */
export interface ApprovalResponse {
  readonly decision: "approve";
}

/** Context passed to an approval response policy. */
export interface ApprovalResponseContext<TInput = Record<string, unknown>> {
  readonly auth: ApprovalResponseAuth;
  readonly request: ApprovalRequest<TInput>;
  readonly response: ApprovalResponse;
  readonly responder: SessionAuthContext;
  readonly session: ApprovalResponseSession;
}

/** Response policy decision. Rejection keeps the shared request pending. */
export type ApprovalResponseDecision =
  | { readonly status: "allowed" }
  | { readonly safeReason: string; readonly status: "rejected" };

/** Decides whether an authenticated responder may approve one request. */
export type ApprovalResponsePolicy<TInput = Record<string, unknown>> = (
  ctx: ApprovalResponseContext<TInput>,
) => ApprovalResponseDecision | Promise<ApprovalResponseDecision>;

/** Approval definition with request- and response-time policy. */
export interface ApprovalConfiguration<TInput = Record<string, unknown>> {
  readonly request: ApprovalPolicy<TInput>;
  readonly response?: ApprovalResponsePolicy<TInput>;
}

/** Shared approval definition used by authored tools and connections. */
export type Approval<TInput = Record<string, unknown>> =
  | ApprovalPolicy<TInput>
  | ApprovalConfiguration<TInput>;

/** Returns the request-time policy from either approval authoring shape. */
export function resolveApprovalPolicy<TInput>(approval: Approval<TInput>): ApprovalPolicy<TInput> {
  return typeof approval === "function" ? approval : approval.request;
}
