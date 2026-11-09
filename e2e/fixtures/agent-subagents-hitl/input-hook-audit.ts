import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface InputHookObservation {
  readonly subscriber: "typed" | "wildcard";
  /** The opening fact's position, as `line:index`. */
  readonly position: string;
  readonly sessionId: string;
  readonly interactionId: string;
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
  if (event.type !== "interaction.opened") return;
  inputHookAudit.update((observations) => [
    ...observations,
    {
      subscriber,
      position: `${ctx.position.line}:${ctx.position.index}`,
      sessionId: ctx.session.id,
      interactionId: event.data.interactionId,
    },
  ]);
}
