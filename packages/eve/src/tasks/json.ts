import { z } from "#compiled/zod/index.js";

import { jsonValueSchema } from "#shared/json-schemas.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskView } from "#tasks/types.js";
import { readSubagentTaskMetadata } from "#tasks/types.js";

const taskMetadataJsonSchema = z.union([
  z.object({
    agentId: z.string(),
    kind: z.literal("subagent"),
    mode: z.enum(["local", "remote"]),
    name: z.string(),
  }),
  z.object({
    kind: z.string(),
    name: z.string(),
  }),
]);

const taskOutputJsonSchema = z.object({
  data: jsonValueSchema,
  type: z.enum(["result", "error"]),
});

const taskViewJsonBaseShape = {
  metadata: taskMetadataJsonSchema,
  taskId: z.string(),
};

/**
 * Model-visible task shape. Unlisted private fields are stripped by zod.
 *
 * Single source of truth for the model-facing projection: tool outputs
 * (`task_cancel`) advertise this same schema via
 * `#runtime/framework-tools/tasks.js`.
 */
export const taskViewJsonSchema = z.discriminatedUnion("status", [
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

/** Broad schema advertised by task-control tool outputs. */
export const taskViewOutputSchema = z.object({
  inputRequests: z.array(z.unknown()).optional(),
  lastOutput: z
    .object({
      data: z.unknown(),
      type: z.enum(["result", "error"]),
    })
    .optional(),
  metadata: z.union([
    z.object({
      agentId: z.string(),
      kind: z.literal("subagent"),
      mode: z.enum(["local", "remote"]),
      name: z.string(),
    }),
    z.object({
      data: z.record(z.string(), z.unknown()).optional(),
      kind: z.string(),
      name: z.string(),
    }),
  ]),
  status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
  taskId: z.string(),
});

/**
 * Model-visible task view, inferred from {@link taskViewJsonSchema}.
 *
 * This is the public projection of `TaskView` (#tasks/types.js), not a
 * replacement for it: the durable view additionally carries private
 * `executor` and `usage`, and its module must stay zod-free because it is
 * bundled into workflow bodies.
 */
type TaskViewJson = z.infer<typeof taskViewJsonSchema>;

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
  return taskViewJsonSchema.parse({ ...view, metadata });
}

/** Projects many views into one `{ tasks }` tool output. */
export function taskViewsToJson(views: readonly TaskView[]): JsonValue {
  return { tasks: views.map((view) => taskViewToJson(view)) };
}
