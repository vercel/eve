import type { ApprovalContext, ApprovalPolicy, ApprovalStatus } from "eve/tools/approval";

import { personal } from "./personal.ts";
import {
  decideAudience,
  decidePrivateContext,
  strictestOf,
  type AudiencePolicyOptions,
  type PrivateContextPolicyOptions,
} from "./private-context.ts";

/**
 * Asks a person before calls tagged `effect:external` or `effect:export` once the session has
 * read someone's personal data (a call tagged `reads:personal`). Until then it returns
 * `undefined`.
 */
export function privateContextPolicy(options: PrivateContextPolicyOptions = {}): ApprovalPolicy {
  return (ctx) => decidePrivateContext(personal.get(), ctx, options);
}

/**
 * Denies calls tagged `reads:personal` in a conversation visible outside its participants:
 * `ctx.session.audience` is `"public"`, or `"unknown"` unless `treatUnknownAs` is `"private"`.
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
 * approval: strictest(taintPolicy(), privateContext()),
 * ```
 */
export function strictest(...policies: readonly ApprovalPolicy[]): ApprovalPolicy {
  return async (ctx: ApprovalContext) => {
    const statuses: ApprovalStatus[] = [];
    for (const policy of policies) statuses.push(await policy(ctx));
    return strictestOf(statuses);
  };
}
