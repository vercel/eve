import { defineState } from "eve/context";
import type { ResolveContext } from "eve/skills";

function snapshot(ctx: ResolveContext) {
  return {
    session: {
      id: ctx.session.id,
      auth: ctx.session.auth,
      schedule: ctx.session.schedule ?? null,
      predecessor: ctx.session.predecessor ?? null,
    } satisfies Record<keyof ResolveContext["session"], unknown>,
    channel: {
      kind: ctx.channel.kind ?? null,
      continuationToken: ctx.channel.continuationToken ?? null,
      metadata: ctx.channel.metadata ?? null,
    } satisfies Record<keyof ResolveContext["channel"], unknown>,
    conversation: ctx.conversation ?? null,
  };
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
  ctx: ResolveContext,
): void {
  dynamicSkillContextAudit.update((observations) => [
    ...observations,
    { event, context: snapshot(ctx) },
  ]);
}
