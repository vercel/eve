import type { AuthorizationSignal } from "#harness/authorization.js";
import type { ToolSignIn } from "#harness/call-executor.js";
import { resolveActiveAuthorizationChallenges } from "#harness/hitl/sign-ins.js";
import type { ApprovedCall } from "#harness/session-machine/view.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";

/** A call a sign-in stopped, the connections it needs, and the approval it ran on, if any. */
export interface StoppedCall {
  readonly call: ApprovedCall["call"];
  readonly connections: readonly string[];
  readonly approval?: Pick<ApprovedCall, "interactionId" | "responder">;
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
    calls: input.signIns.map(({ callId, input: args, signal, toolName }) => {
      const action = createRuntimeToolCallActionFromToolCall({
        toolCall: { input: args, toolCallId: callId, toolName },
      });
      return {
        call: { callId: action.callId, input: action.input, toolName: action.toolName },
        connections: signal.challenges.map((challenge) => challenge.name),
      };
    }),
    challenges: resolveActiveAuthorizationChallenges(
      input.signIns.flatMap(({ signal }) => signal.challenges),
    ),
  };
}
