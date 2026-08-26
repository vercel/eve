import type { ActivitySinkV1 } from "#channel/types.js";
import { projectActivityEvents } from "#execution/activity-events.js";
import { submitActivity } from "#execution/submit-activity.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export interface ActivityObserver {
  observe(event: MessageStreamEvent): Promise<void>;
}

export function createActivityObserver(input: {
  readonly sessionId: string;
  readonly sink: ActivitySinkV1;
  readonly workIdentity?: ActivityWorkIdentityV1;
}): ActivityObserver {
  const startedWork = new Set<string>();

  const submit = async (events: readonly ActivityEventV1[]): Promise<void> => {
    await submitActivity({ events, sink: input.sink });
  };

  const workFor = (event: MessageStreamEvent): ActivityWorkIdentityV1 | undefined => {
    if (input.workIdentity !== undefined) {
      const turnId = eventTurnId(event);
      return {
        ...input.workIdentity,
        sessionId: input.sessionId,
        turnId: turnId ?? input.workIdentity.turnId,
      };
    }
    const turnId = eventTurnId(event);
    if (turnId === undefined) return undefined;
    return {
      id: `root:${input.sessionId}:${turnId}`,
      kind: "root-turn",
      rootSessionId: input.sessionId,
      rootTurnId: turnId,
      sessionId: input.sessionId,
      turnId,
    };
  };

  return {
    async observe(event) {
      const work = workFor(event);
      if (work === undefined) return;

      const events: ActivityEventV1[] = [];
      if (!startedWork.has(work.id)) {
        startedWork.add(work.id);
        events.push({
          eventId: `${work.id}:started`,
          kind: "work.started",
          startedAt: event.meta.at,
          work,
        });
      }
      events.push(...projectActivityEvents({ at: event.meta.at, event, lineage: work }));

      await submit(events);
    },
  };
}

function eventTurnId(event: MessageStreamEvent): string | undefined {
  if ("data" in event && "turnId" in event.data && typeof event.data.turnId === "string") {
    return event.data.turnId;
  }
  return undefined;
}
