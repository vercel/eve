import type { DynamicContext } from "eve/skills";

function snapshot(ctx: DynamicContext) {
  return {
    session: {
      id: ctx.session.id,
      auth: ctx.session.auth,
      schedule: ctx.session.schedule ?? null,
      predecessor: ctx.session.predecessor ?? null,
      parent: ctx.session.parent ?? null,
    } satisfies Record<keyof DynamicContext["session"], unknown>,
    channel: {
      kind: ctx.channel.kind ?? null,
      continuationToken: ctx.channel.continuationToken ?? null,
      metadata: ctx.channel.metadata ?? null,
    } satisfies Record<keyof DynamicContext["channel"], unknown>,
    conversation: ctx.conversation ?? null,
  };
}

export interface DynamicSkillContextObservation {
  readonly turnId: string | null;
  readonly context: ReturnType<typeof snapshot>;
}

/**
 * Observations by session, kept independently of the definition's memo state.
 */
const observations = new Map<string, DynamicSkillContextObservation[]>();

export function recordDynamicSkillContext(ctx: DynamicContext): void {
  observations.set(ctx.session.id, [
    ...(observations.get(ctx.session.id) ?? []),
    { turnId: ctx.turn?.id ?? null, context: snapshot(ctx) },
  ]);
}

export function dynamicSkillContextObservations(
  sessionId: string,
): readonly DynamicSkillContextObservation[] {
  return observations.get(sessionId) ?? [];
}
