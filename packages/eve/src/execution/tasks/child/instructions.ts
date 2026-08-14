import { SessionCallbackKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";

export const TASK_UPDATE_SESSION_INSTRUCTION =
  "Background task updates\nYou are running as a background task. For multi-step work, use `task_update` at meaningful milestones to briefly state what you are currently doing. Keep updates terse and activity-focused; do not include preliminary findings or results. Do not wait for a response, and return your final result normally.";

/** True when the serialized caller binding points at a durable task inbox. */
export function isTaskOwnedSerializedContext(serializedContext: Record<string, unknown>): boolean {
  const callback = serializedContext[SessionCallbackKey.name];
  if (
    callback !== null &&
    typeof callback === "object" &&
    typeof Reflect.get(callback, "taskId") === "string"
  ) {
    return true;
  }
  const channel = serializedContext[ChannelKey.name];
  if (channel === null || typeof channel !== "object") return false;
  const state = Reflect.get(channel, "state");
  if (state === null || typeof state !== "object") return false;
  const token = Reflect.get(state, "parentContinuationToken");
  return typeof token === "string" && readTaskIdFromInboxToken(token) !== undefined;
}
