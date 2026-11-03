import type { ApprovalPolicy } from "eve/tools/approval";

import { exposure } from "./exposure.ts";
import { decide, expose, readsOf, runtimeContextOf, type TaintPolicyOptions } from "./taint.ts";

/**
 * An agent-wide approval policy for Meta's Rule of Two: a call needs a person only when the
 * session combines untrusted content, sensitive data, and an external effect. Once all three
 * meet, it asks before calls tagged `effect:external` and denies calls tagged `effect:export`.
 * Otherwise it returns `undefined` and leaves every call to its own approval.
 *
 * ```ts
 * // agent/agent.ts
 * import { defineAgent } from "eve";
 * import { taintPolicy } from "eve/extensions/taint";
 *
 * export default defineAgent({ approval: taintPolicy() });
 * ```
 */
export function taintPolicy(options: TaintPolicyOptions = {}): ApprovalPolicy {
  return (ctx) => {
    // Decide before marking, so a call that both reads and acts (`bash`) isn't gated by itself.
    const status = decide(exposure.get(), ctx, options);
    if (options.markOnRequest === true) {
      for (const leg of readsOf({ name: ctx.toolName, tags: ctx.toolTags })) {
        exposure.update((state) => expose(state, leg, ctx.toolName));
      }
    }
    return status;
  };
}

/**
 * Span attributes for `otelIntegration({ runtimeContext })`: `taint.exposed`, `taint.sensitive`,
 * and their comma-joined sources. They reach the AI SDK spans of each model call.
 */
export function taintRuntimeContext(): ReturnType<typeof runtimeContextOf> {
  return runtimeContextOf(exposure.get());
}
