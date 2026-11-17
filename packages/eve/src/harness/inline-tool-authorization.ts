import type { AuthorizationSignal } from "#harness/authorization.js";
import type { ToolSignIn } from "#harness/call-executor.js";
import { resolveActiveAuthorizationChallenges } from "#harness/hitl/sign-ins.js";
import type { ApprovedCall } from "#harness/session-machine/view.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";

export interface StoppedCall {
  readonly call: ApprovedCall["call"];
  readonly connections: readonly string[];
  readonly approval?: Pick<ApprovedCall, "interactionId" | "responder">;
}

export function resolveInlineAuthorizationInterrupt(input: {
  readonly signIns: readonly ToolSignIn[];
}):
  | {
      readonly challenges: AuthorizationSignal["challenges"];
      readonly calls: readonly StoppedCall[];
    }
  | undefined {
  if (input.signIns.length === 0) return undefined;
  return {
    calls: input.signIns.map(({ callId, input: args, signal, toolName, version }) => {
      return {
        call: {
          callId,
          input: resolveToolCallInputObject(args, { callId, toolName }),
          toolName,
          ...(version !== undefined && { version }),
        },
        connections: signal.challenges.map((challenge) => challenge.name),
      };
    }),
    challenges: resolveActiveAuthorizationChallenges(
      input.signIns.flatMap(({ signal }) => signal.challenges),
    ),
  };
}
