import { projectActivityEvents } from "#execution/activity-events.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";

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
    (work.kind !== "root-turn" && input.event.type === "session.started")
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
