import type { ApprovalContext, ApprovalPolicy, ApprovalStatus } from "eve/tools/approval";

import { personal } from "./personal.ts";
import {
  decideAudience,
  decidePrivateContext,
  exceeded,
  runtimeContextOf,
  strictestOf,
  type AudiencePolicyOptions,
  type PrivateContextPolicyOptions,
} from "./private-context.ts";

/** Who a `sink:user` shows data to: the caller of the turn that made the call. */
function callerOf(ctx: ApprovalContext): string | undefined {
  return ctx.session.auth.current?.principalId ?? personal.get().caller;
}

/**
 * Asks a person before a call that would send confidential data past what its destination may
 * see: personal data anywhere but back to its owner (`sink:user`), and sensitive data to a public
 * sink. An external call with no `sink:*` tag is capped at public.
 */
export function privateContextPolicy(options: PrivateContextPolicyOptions = {}): ApprovalPolicy {
  return (ctx) => decidePrivateContext(personal.get(), ctx, callerOf(ctx), options);
}

/**
 * Whether a call would send confidential data past its sink's cap. Pass it to
 * `untrustedContentPolicy({ when: exceedsCap })` for the Rule of Two.
 */
export function exceedsCap(ctx: ApprovalContext): boolean {
  return exceeded(personal.get(), ctx, callerOf(ctx)) !== undefined;
}

/**
 * Denies a read the conversation's readers shouldn't see: `reads:personal` unless
 * `ctx.session.audience` is `"private"`, and `reads:sensitive` when it's visible outside the
 * organization. eve's `"public"` counts as the workspace; `"unknown"` follows `treatUnknownAs`.
 */
export function audiencePolicy(options: AudiencePolicyOptions = {}): ApprovalPolicy {
  return (ctx) => decideAudience(ctx.session.audience, ctx, options);
}

/** {@link privateContextPolicy} and {@link audiencePolicy}, combined with {@link strictest}. */
export function privateContext(
  options: PrivateContextPolicyOptions & AudiencePolicyOptions = {},
): ApprovalPolicy {
  return strictest(privateContextPolicy(options), audiencePolicy(options));
}

/**
 * Combines approval policies into one that returns the strictest answer: denied, then user
 * approval, then approved, then `undefined`. Among equals the first wins, so its reason is kept.
 *
 * ```ts
 * approval: strictest(untrustedContentPolicy({ when: exceedsCap }), privateContext()),
 * ```
 */
export function strictest(...policies: readonly ApprovalPolicy[]): ApprovalPolicy {
  return async (ctx: ApprovalContext) => {
    const statuses: ApprovalStatus[] = [];
    for (const policy of policies) statuses.push(await policy(ctx));
    return strictestOf(statuses);
  };
}

/**
 * Span attributes for `otelIntegration({ runtimeContext })`: `private.sensitive`,
 * `private.personal`, and their comma-joined sources. They reach the AI SDK spans of each model
 * call. Owners are left out, so traces carry no principal ids.
 */
export function privateContextRuntimeContext(): ReturnType<typeof runtimeContextOf> {
  return runtimeContextOf(personal.get());
}
