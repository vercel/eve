import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface SubagentHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly type: "subagent.called" | "subagent.completed";
  readonly callId: string;
  readonly eventId: string;
  readonly policy: string;
  readonly retryEventId?: string;
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
  let retryEventId: string | undefined;
  if (
    subscriber === "wildcard" &&
    event.type === "subagent.completed" &&
    (event.data.output.includes("hook-audit:") || event.data.output.includes("Alice's hook audit"))
  ) {
    const path = `subagent-hook-retry-${event.data.callId}.txt`;
    const previous = await sandbox.readTextFile({ path });
    if (previous === null) {
      // The sandbox survives the hook step's failed attempt; context writes do not.
      await sandbox.writeTextFile({ path, content: event.meta.id });
      throw new Error("Retry the hook after its event was published.");
    }
    retryEventId = previous;
  }
  subagentHookAudit.update((observations) => [
    ...observations,
    {
      subscriber,
      type: event.type,
      callId: event.data.callId,
      eventId: event.meta.id,
      policy,
      retryEventId,
      sessionId: ctx.session.id,
      output: event.type === "subagent.completed" ? event.data.output : undefined,
    },
  ]);
}
