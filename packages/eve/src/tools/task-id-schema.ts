import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";

import { SEND_INPUT_SCHEMA_HINT, TASK_ID_SEND_PARAMETER_DESCRIPTION } from "#tasks/render.js";
import { deriveToolSchema, isToolSchema, type ToolSchema } from "#tools/schema.js";

/** The input a resumable tool's call carries to send to one of its tasks. */
export const TASK_ID_PARAMETER = "taskId";

/**
 * Adds the model-facing `taskId` to a resumable tool's input schema, once,
 * when its harness definition is built. The author's schema never sees
 * `taskId`: validation takes it out, validates the rest with the author's
 * schema, and puts it back, so a send is validated like a start. A `null` or
 * empty `taskId` is taken out as absent: the call starts a task.
 */
export function withTaskIdParameter<T>(schema: T): T | ToolSchema {
  if (!isToolSchema(schema)) return schema;
  const standard = schema["~standard"];
  const input = (options: StandardJSONSchemaV1.Options): Record<string, unknown> => {
    const json = standard.jsonSchema.input(options);
    const properties = (json.properties ?? {}) as Record<string, unknown>;
    if ((json.type !== undefined && json.type !== "object") || TASK_ID_PARAMETER in properties) {
      throw new Error(
        `A resumable tool needs an object input schema without its own "${TASK_ID_PARAMETER}" property.`,
      );
    }
    return {
      ...json,
      properties: {
        ...properties,
        [TASK_ID_PARAMETER]: { description: TASK_ID_SEND_PARAMETER_DESCRIPTION, type: "string" },
      },
      type: "object",
    };
  };
  const wrapped = {
    "~standard": {
      ...standard,
      jsonSchema: { input, output: standard.jsonSchema.output },
      async validate(value: unknown): Promise<StandardSchemaV1.Result<unknown>> {
        if (typeof value !== "object" || value === null || !(TASK_ID_PARAMETER in value)) {
          return await standard.validate(value);
        }
        const { [TASK_ID_PARAMETER]: taskId, ...rest } = value as Record<string, unknown>;
        if (taskId === null || taskId === undefined || taskId === "") {
          return await standard.validate(rest);
        }
        if (typeof taskId !== "string") {
          return {
            issues: [
              { message: `${TASK_ID_PARAMETER} must be a string.`, path: [TASK_ID_PARAMETER] },
            ],
          };
        }
        const result = await standard.validate(rest);
        if (result.issues !== undefined) {
          return { issues: [...result.issues, { message: SEND_INPUT_SCHEMA_HINT }] };
        }
        return { value: { ...(result.value as object), [TASK_ID_PARAMETER]: taskId } };
      },
    },
  } as ToolSchema;
  return deriveToolSchema(wrapped, schema);
}
