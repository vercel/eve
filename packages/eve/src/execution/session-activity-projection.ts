import type { ContextContainer } from "#context/container.js";
import { ActivityObserverKey } from "#context/keys.js";
import { projectActivityEvents } from "#execution/activity-events.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import { submitActivity } from "#execution/submit-activity.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";

/** Projects one canonical session event into best-effort activity presentation. */
export async function observeSessionActivity(input: {
  readonly ctx: ContextContainer;
  readonly event: MessageStreamEvent;
  readonly sessionId: string;
}): Promise<void> {
  const observer = input.ctx.get(ActivityObserverKey);
  if (observer === undefined) return;
  await submitActivity({
    events: projectSessionActivity({
      event: input.event,
      sessionId: input.sessionId,
      workIdentity: observer.workIdentity,
    }),
    sink: observer.sink,
  });
}

export function projectSessionActivity(input: {
  readonly event: MessageStreamEvent;
  readonly sessionId: string;
  readonly workIdentity?: ActivityWorkIdentityV1;
}): readonly ActivityEventV1[] {
  const work = workFor(input);
  if (work === undefined) return [];

  const events: ActivityEventV1[] = [];
  if (
    (work.kind === "root-turn" && input.event.type === "turn.started") ||
    (work.kind !== "root-turn" &&
      (input.event.type === "session.started" || input.event.type === "turn.started"))
  ) {
    events.push({
      eventId: `${work.id}:started`,
      kind: "work.started",
      startedAt: input.event.meta.at,
      work,
    });
  }
  events.push(
    ...projectActivityEvents({ at: input.event.meta.at, event: input.event, lineage: work }),
  );
  return events;
}

function workFor(input: {
  readonly event: MessageStreamEvent;
  readonly sessionId: string;
  readonly workIdentity?: ActivityWorkIdentityV1;
}): ActivityWorkIdentityV1 | undefined {
  const turnId = eventTurnId(input.event);
  if (input.workIdentity !== undefined) {
    return {
      ...input.workIdentity,
      sessionId: input.sessionId,
      turnId: turnId ?? input.workIdentity.turnId,
    };
  }
  if (turnId === undefined) return undefined;
  return {
    id: deriveRootTurnActivityWorkId({ sessionId: input.sessionId, turnId }),
    kind: "root-turn",
    rootSessionId: input.sessionId,
    rootTurnId: turnId,
    sessionId: input.sessionId,
    turnId,
  };
}

function eventTurnId(event: MessageStreamEvent): string | undefined {
  if ("data" in event && "turnId" in event.data && typeof event.data.turnId === "string") {
    return event.data.turnId;
  }
  return undefined;
}
