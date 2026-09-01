import type { ActivityObserverConfig } from "#channel/types.js";
import { submitActivity } from "#execution/submit-activity.js";
import type { ActivityEventV1 } from "#protocol/activity.js";
import type { TaskView } from "#tasks/types.js";

/** Projects one canonical task-view event into best-effort activity presentation. */
export async function observeTaskActivity(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly settledAt: string;
  readonly view: TaskView;
}): Promise<void> {
  await submitActivity({
    events: projectTaskActivity(input),
    sink: input.activityObserver?.sink,
  });
}

export function projectTaskActivity(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly settledAt: string;
  readonly view: TaskView;
}): readonly ActivityEventV1[] {
  const work = input.activityObserver?.workIdentity;
  if (work === undefined) return [];
  const started: ActivityEventV1 = {
    eventId: `${work.id}:started`,
    kind: "work.started",
    startedAt: input.settledAt,
    work,
  };
  const status = input.view.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return [started];
  return [
    started,
    {
      eventId: `${work.id}:settled:${status}`,
      kind: "work.settled",
      outcome: status,
      settledAt: input.settledAt,
      workId: work.id,
    },
  ];
}
