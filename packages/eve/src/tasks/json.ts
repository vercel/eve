import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TaskView } from "#tasks/types.js";

/**
 * Projects a task snapshot into the JSON value carried by tool results.
 * Field-by-field on purpose: it is the one place that decides what the
 * model may see, and it stays a compile error when `TaskView` grows a
 * field that needs a disclosure decision.
 */
export function taskViewToJson(view: TaskView): JsonObject {
  const metadata: Record<string, JsonValue> = {
    agentId: view.metadata.agentId,
    kind: view.metadata.kind,
    mode: view.metadata.mode,
    name: view.metadata.name,
  };

  const json: Record<string, JsonValue> = {
    metadata,
    status: view.status,
    taskId: view.taskId,
  };
  if (view.lastOutput !== undefined) {
    json.lastOutput = { data: view.lastOutput.data, type: view.lastOutput.type };
  }
  if (view.inputRequests !== undefined) {
    json.inputRequests = [...view.inputRequests];
  }
  // `view.executor` and `view.usage` are deliberately not disclosed: they
  // are private routing/accounting state, not model-visible task data.
  return json;
}

/** Projects many snapshots into one `{ tasks }` tool output. */
export function taskViewsToJson(views: readonly TaskView[]): JsonValue {
  return { tasks: views.map((view) => taskViewToJson(view)) };
}
