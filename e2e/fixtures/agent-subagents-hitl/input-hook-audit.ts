import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface InputHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly eventId: string;
  readonly sessionId: string;
  readonly requestIds: readonly string[];
}

export const inputHookAudit = defineState<InputHookObservation[]>(
  "hitl-fixture.input-hook-audit",
  () => [],
);

export function recordInputHook(
  subscriber: InputHookObservation["subscriber"],
  event: HookEvent,
  ctx: HookContext,
): void {
  if (event.type !== "input.requested") return;
  inputHookAudit.update((observations) => [
    ...observations,
    {
      subscriber,
      eventId: event.meta.id,
      sessionId: ctx.session.id,
      requestIds: event.data.requests.map((request) => request.requestId),
    },
  ]);
}
