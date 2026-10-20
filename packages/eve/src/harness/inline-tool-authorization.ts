import type { AuthorizationSignal } from "#harness/authorization.js";
import type { ToolSignIn } from "#harness/call-executor.js";
import { resolveActiveAuthorizationChallenges } from "#harness/hitl/sign-ins.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";

/** A call a sign-in stopped, as the entry it ran, and the connections it needs. */
export interface StoppedCall {
  readonly action: RuntimeToolCallActionRequest;
  readonly connections: readonly string[];
}

/** Resolves the sign-ins that stopped calls. */
export function resolveInlineAuthorizationInterrupt(input: {
  readonly signIns: readonly ToolSignIn[];
}):
  | {
      readonly challenges: AuthorizationSignal["challenges"];
      /** The calls sign-ins stopped, each with the connections it needs. */
      readonly calls: readonly StoppedCall[];
    }
  | undefined {
  if (input.signIns.length === 0) return undefined;
  return {
    calls: input.signIns.map(({ callId, input: args, signal, toolName }) => ({
      action: createRuntimeToolCallActionFromToolCall({
        toolCall: { input: args, toolCallId: callId, toolName },
      }),
      connections: signal.challenges.map((challenge) => challenge.name),
    })),
    challenges: resolveActiveAuthorizationChallenges(
      input.signIns.flatMap(({ signal }) => signal.challenges),
    ),
  };
}
