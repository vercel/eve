import type { FactType, ProgressType } from "./catalog.js";

// Opt in here: adding a protocol record does not automatically expose a new authoring hook.
export const authoringEventTypes = [
  "session.started",
  "session.ended",
  "delivery.admitted",
  "delivery.consumed",
  "delivery.settled",
  "turn.started",
  "turn.paused",
  "turn.settled",
  "model.requested",
  "model.started",
  "model.retried",
  "model.settled",
  "content.delta",
  "content.completed",
  "call.input",
  "call.requested",
  "call.started",
  "call.progress",
  "call.settled",
  "usage.recorded",
  "context.started",
  "context.settled",
  "interaction.opened",
  "interaction.settled",
  "response.submitted",
  "response.admitted",
  "response.settled",
  "child.opened",
  "task.ended",
  "task.started",
] as const satisfies readonly (FactType | ProgressType)[];

export type AuthoringEventType = (typeof authoringEventTypes)[number];
