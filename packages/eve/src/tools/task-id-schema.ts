import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";

import { MAX_TASK_ID_LENGTH } from "#tasks/ids.js";
import {
  SEND_INPUT_SCHEMA_HINT,
  TASK_ID_INVALID_MESSAGE,
  TASK_ID_SEND_PARAMETER_DESCRIPTION,
} from "#tasks/render.js";
import { deriveToolSchema, isToolSchema, type ToolSchema } from "#tools/schema.js";

/** The input a resumable tool's call carries to send to one of its tasks. */
export const TASK_ID_PARAMETER = "taskId";

/**
 * Why a resumable tool's input schema, as JSON Schema, cannot take `taskId`,
 * or `undefined` when it can. The compiler checks it, so a bad schema fails
 * the build instead of every turn that lists the tool.
 */
export function resumableInputSchemaError(json: Record<string, unknown>): string | undefined {
  if (json.type !== undefined && json.type !== "object") {
    return `A resumable tool's inputSchema must describe an object, because eve adds "${TASK_ID_PARAMETER}" to it for sends to the tool's tasks; this one has type ${JSON.stringify(json.type)}.`;
  }
  const properties = json.properties;
  if (typeof properties === "object" && properties !== null && TASK_ID_PARAMETER in properties) {
    return `A resumable tool's inputSchema cannot declare "${TASK_ID_PARAMETER}", because eve adds it for sends to the tool's tasks; rename that property.`;
  }
  return undefined;
}

/**
 * Adds the model-facing `taskId` to a resumable tool's input schema, once,
 * when its harness definition is built. The author's schema never sees
 * `taskId`: validation takes it out, validates the rest with the author's
 * schema, and puts it back, so a send is validated like a start. A `null` or
 * empty `taskId` is taken out as absent: the call starts a task.
 */
export function withTaskIdParameter(schema: unknown): ToolSchema {
  // Every authored and prepared tool's input schema is resolved to one.
  if (!isToolSchema(schema)) {
    throw new Error("A resumable tool's input schema must be an eve tool schema to take taskId.");
  }
  const standard = schema["~standard"];
  const input = (options: StandardJSONSchemaV1.Options): Record<string, unknown> => {
    const json = standard.jsonSchema.input(options);
    const error = resumableInputSchemaError(json);
    if (error !== undefined) throw new Error(error);
    return {
      ...json,
      properties: {
        ...(json.properties as Record<string, unknown> | undefined),
        [TASK_ID_PARAMETER]: {
          description: TASK_ID_SEND_PARAMETER_DESCRIPTION,
          maxLength: MAX_TASK_ID_LENGTH,
          type: "string",
        },
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
        if (typeof taskId !== "string" || taskId.length > MAX_TASK_ID_LENGTH) {
          return { issues: [{ message: TASK_ID_INVALID_MESSAGE, path: [TASK_ID_PARAMETER] }] };
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
