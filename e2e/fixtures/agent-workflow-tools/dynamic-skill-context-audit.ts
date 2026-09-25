import { defineState } from "eve/context";
import type { DynamicResolveContext } from "eve/skills";

function snapshot(ctx: DynamicResolveContext) {
  return {
    abortSignal: ctx.abortSignal === undefined ? null : { aborted: ctx.abortSignal.aborted },
    model: ctx.model,
    session: {
      id: ctx.session.id,
      auth: ctx.session.auth,
      context: ctx.session.context,
    } satisfies Record<keyof DynamicResolveContext["session"], unknown>,
    channel: {
      kind: ctx.channel.kind ?? null,
      continuationToken: ctx.channel.continuationToken ?? null,
      metadata: ctx.channel.metadata ?? null,
    } satisfies Record<keyof DynamicResolveContext["channel"], unknown>,
    conversation: ctx.conversation ?? null,
    messages: ctx.messages,
  } satisfies Record<keyof DynamicResolveContext, unknown>;
}

export interface DynamicSkillContextObservation {
  readonly event: "session.started" | "turn.started";
  readonly context: ReturnType<typeof snapshot>;
}

export const dynamicSkillContextAudit = defineState<DynamicSkillContextObservation[]>(
  "workflow-fixture.dynamic-skill-context-audit",
  () => [],
);

export function recordDynamicSkillContext(
  event: DynamicSkillContextObservation["event"],
  ctx: DynamicResolveContext,
): void {
  dynamicSkillContextAudit.update((observations) => [
    ...observations,
    { event, context: snapshot(ctx) },
  ]);
}
