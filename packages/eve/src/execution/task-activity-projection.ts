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
  const status = input.view.status;
  if (
    work === undefined ||
    (status !== "completed" && status !== "failed" && status !== "cancelled")
  ) {
    return [];
  }
  return [
    {
      eventId: `${work.id}:settled:${status}`,
      kind: "work.settled",
      outcome: status,
      settledAt: input.settledAt,
      workId: work.id,
    },
  ];
}
