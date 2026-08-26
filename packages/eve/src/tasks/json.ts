import type { z } from "#compiled/zod/index.js";

import type { JsonValue } from "#shared/json.js";
import { TASK_VIEW_JSON_SCHEMA } from "#tools/framework/task-contract.js";
import type { TaskView } from "#tasks/types.js";
import { readSubagentTaskMetadata } from "#tasks/types.js";

/**
 * Model-visible task view, inferred from {@link TASK_VIEW_JSON_SCHEMA}.
 *
 * This is the public projection of `TaskView` (#tasks/types.js), not a
 * replacement for it: the durable view additionally carries private
 * `executor` and `usage`, and its module must stay zod-free because it is
 * bundled into workflow bodies.
 */
type TaskViewJson = z.infer<typeof TASK_VIEW_JSON_SCHEMA>;

/** Projects a task view into the JSON value carried by tool results. */
export function taskViewToJson(view: TaskView): TaskViewJson {
  const subagent = readSubagentTaskMetadata(view);
  const metadata =
    subagent === undefined
      ? view.metadata
      : {
          agentId: subagent.agentId,
          kind: subagent.kind,
          mode: subagent.mode,
          name: subagent.name,
        };
  // `satisfies` couples the schema to `TaskView` at compile time; the runtime
  // parse strips the private fields structural typing would let through.
  return TASK_VIEW_JSON_SCHEMA.parse({ ...view, metadata });
}

/** Projects many views into one `{ tasks }` tool output. */
export function taskViewsToJson(views: readonly TaskView[]): JsonValue {
  return { tasks: views.map((view) => taskViewToJson(view)) };
}
