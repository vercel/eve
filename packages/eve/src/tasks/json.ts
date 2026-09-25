import { z } from "#compiled/zod/index.js";

import type { JsonValue } from "#shared/json.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import type { TaskView } from "#tasks/types.js";

const taskMetadataJsonSchema = z.object({
  agentId: z.string().optional(),
  kind: z.string(),
  mode: z.enum(["local", "remote"]).optional(),
  name: z.string(),
});

const taskOutputJsonSchema = z.object({
  data: jsonValueSchema,
  type: z.enum(["result", "error"]),
});

const taskViewJsonBaseShape = {
  metadata: taskMetadataJsonSchema,
  taskId: z.string(),
};

/** Strict model-visible task projection. */
const TASK_VIEW_JSON_SCHEMA = z.discriminatedUnion("status", [
  z.object({ ...taskViewJsonBaseShape, status: z.literal("working") }),
  z.object({
    ...taskViewJsonBaseShape,
    inputRequests: z.array(jsonValueSchema).readonly(),
    status: z.literal("input_required"),
  }),
  z.object({
    ...taskViewJsonBaseShape,
    lastOutput: taskOutputJsonSchema.extend({ type: z.literal("result") }),
    status: z.literal("completed"),
  }),
  z.object({
    ...taskViewJsonBaseShape,
    lastOutput: taskOutputJsonSchema.extend({ type: z.literal("error") }),
    status: z.literal("failed"),
  }),
  z.object({ ...taskViewJsonBaseShape, status: z.literal("cancelled") }),
]);

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
  // `satisfies` couples the schema to `TaskView` at compile time; the runtime
  // parse strips the private fields structural typing would let through.
  return TASK_VIEW_JSON_SCHEMA.parse(view);
}

/** Projects many views into one `{ tasks }` tool output. */
export function taskViewsToJson(views: readonly TaskView[]): JsonValue {
  return { tasks: views.map((view) => taskViewToJson(view)) };
}
