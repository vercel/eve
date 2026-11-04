import type { ApprovalPolicy } from "eve/tools/approval";

import { exposure } from "./exposure.ts";
import {
  decide,
  expose,
  readsUntrusted,
  runtimeContextOf,
  type TaintPolicyOptions,
} from "./taint.ts";

/**
 * An agent-wide approval policy that acts on the session's exposure. Until the session reads
 * untrusted content it returns `undefined` and leaves every call to its own approval. After, it
 * asks a person before calls tagged `effect:external` or `effect:irreversible`, and denies calls
 * that are both irreversible and `sink:public`. With `when`, only irreversible calls and the calls
 * it matches are gated.
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
  return async (ctx) => {
    // Decide before marking, so a call that both reads and acts (`bash`) isn't gated by itself.
    const current = exposure.get();
    const gated = !current.exposed || options.when === undefined || (await options.when(ctx));
    const status = decide(current, ctx, options, gated);
    if (
      options.markOnRequest === true &&
      readsUntrusted({ name: ctx.toolName, tags: ctx.toolTags })
    ) {
      exposure.update((state) => expose(state, ctx.toolName));
    }
    return status;
  };
}

/**
 * Span attributes for `otelIntegration({ runtimeContext })`: `taint.exposed` and the
 * comma-joined `taint.sources`. They reach the AI SDK spans of each model call.
 */
export function taintRuntimeContext(): {
  readonly "taint.exposed": boolean;
  readonly "taint.sources": string;
} {
  return runtimeContextOf(exposure.get());
}
