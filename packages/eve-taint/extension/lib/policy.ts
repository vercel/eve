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
 * denies calls tagged `effect:export` and asks a person before calls tagged `effect:external`.
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
