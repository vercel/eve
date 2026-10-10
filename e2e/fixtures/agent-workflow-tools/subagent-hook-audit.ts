import { defineState } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";

export interface SubagentHookObservation {
  readonly subscriber: "typed" | "wildcard";
  readonly type: "task.started" | "task.settled" | "agent.started";
  readonly callId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly output?: string;
  /** The session an `agent.started` event announced. */
  readonly childSessionId?: string;
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
  if (
    event.type !== "task.started" &&
    event.type !== "task.settled" &&
    event.type !== "agent.started"
  ) {
    return;
  }
  const sandbox = await ctx.getSandbox();
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
      sessionId: ctx.session.id,
      output: event.type === "task.settled" ? readOutput(event.data.output) : undefined,
      childSessionId: event.type === "agent.started" ? event.data.sessionId : undefined,
    },
  ]);
  if (subscriber === "typed") {
    throw new Error("Fixture subagent observer failed after recording its event.");
  }
}

function readOutput(output: unknown): string | undefined {
  return typeof output === "string" ? output : undefined;
}
