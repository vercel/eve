import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface SubagentHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly type: "subagent.called" | "subagent.completed";
  readonly callId: string;
  readonly eventId: string;
  readonly policy: string;
  readonly sessionId: string;
  readonly output?: string;
}

export const subagentHookAudit = defineState<SubagentHookObservation[]>(
  "workflow-fixture.subagent-hook-audit",
  () => [],
);

export async function recordSubagentHook(
  subscriber: SubagentHookObservation["subscriber"],
  event: HookEvent,
  ctx: HookContext,
): Promise<void> {
  if (event.type !== "subagent.called" && event.type !== "subagent.completed") return;
  if (event.type === "subagent.called" && ctx.session.id !== event.data.sessionId) {
    throw new Error("Subagent hook received a different parent session.");
  }
  const sandbox = await ctx.getSandbox();
  const policy = await ctx.getSkill("delegation-policy").file("SKILL.md").text();
  await sandbox.writeTextFile({
    path: `subagent-hook-${event.meta.id}-${subscriber}.txt`,
    content: event.data.callId,
  });
  subagentHookAudit.update((observations) => [
    ...observations,
    {
      subscriber,
      type: event.type,
      callId: event.data.callId,
      eventId: event.meta.id,
      policy,
      sessionId: ctx.session.id,
      output: event.type === "subagent.completed" ? event.data.output : undefined,
    },
  ]);
  if (subscriber === "typed") {
    throw new Error("Fixture subagent observer failed after recording its event.");
  }
}
