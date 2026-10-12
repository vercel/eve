import type { RecordContext } from "eve/skills";

function snapshot(ctx: RecordContext) {
  return {
    session: {
      id: ctx.session.id,
      auth: ctx.session.auth,
      schedule: ctx.session.schedule ?? null,
      predecessor: ctx.session.predecessor ?? null,
    } satisfies Record<keyof RecordContext["session"], unknown>,
    channel: {
      kind: ctx.channel.kind ?? null,
      continuationToken: ctx.channel.continuationToken ?? null,
      metadata: ctx.channel.metadata ?? null,
    } satisfies Record<keyof RecordContext["channel"], unknown>,
    conversation: ctx.conversation ?? null,
  };
}

export interface DynamicSkillContextObservation {
  readonly event: "session.started" | "turn.started";
  readonly context: ReturnType<typeof snapshot>;
}

/**
 * Observations by session. `record` runs outside the session's context, so it can't write
 * session state; the fixture keeps them in the process, which a local run shares.
 */
const observations = new Map<string, DynamicSkillContextObservation[]>();

export function recordDynamicSkillContext(
  event: DynamicSkillContextObservation["event"],
  ctx: RecordContext,
): void {
  observations.set(ctx.session.id, [
    ...(observations.get(ctx.session.id) ?? []),
    { event, context: snapshot(ctx) },
  ]);
}

export function dynamicSkillContextObservations(
  sessionId: string,
): readonly DynamicSkillContextObservation[] {
  return observations.get(sessionId) ?? [];
}
