import { describe, expect, it } from "vitest";

import { SEND_INPUT_SCHEMA_HINT, TASK_ID_SEND_PARAMETER_DESCRIPTION } from "#tasks/render.js";
import { defineJsonSchema, serializeInputSchema, type ToolSchema } from "#tools/schema.js";
import { resumableInputSchemaError, withTaskIdParameter } from "#tools/task-id-schema.js";

const NOTES = defineJsonSchema({
  additionalProperties: false,
  properties: { version: { type: "string" } },
  required: ["version"],
  type: "object",
});

function wrapped(schema: ToolSchema = NOTES): ToolSchema {
  return withTaskIdParameter(schema);
}

async function validate(schema: ToolSchema, value: unknown) {
  return await schema["~standard"].validate(value);
}

describe("withTaskIdParameter", () => {
  it("adds taskId to the model-facing schema and keeps the author's contract", () => {
    expect(serializeInputSchema(wrapped())).toEqual({
      additionalProperties: false,
      properties: {
        taskId: { description: TASK_ID_SEND_PARAMETER_DESCRIPTION, type: "string" },
        version: { type: "string" },
      },
      required: ["version"],
      type: "object",
    });
  });

  it("validates a send with the author's schema, which never sees taskId", async () => {
    await expect(validate(wrapped(), { taskId: "notes-abc234", version: "0.67" })).resolves.toEqual(
      { value: { taskId: "notes-abc234", version: "0.67" } },
    );
    await expect(validate(wrapped(), { version: "0.67" })).resolves.toEqual({
      value: { version: "0.67" },
    });
  });

  it.each([[null], [""]])("reads a %j taskId as a start", async (taskId) => {
    await expect(validate(wrapped(), { taskId, version: "0.67" })).resolves.toEqual({
      value: { version: "0.67" },
    });
  });

  it("rejects a taskId that is not a string", async () => {
    await expect(validate(wrapped(), { taskId: 7, version: "0.67" })).resolves.toEqual({
      issues: [{ message: "taskId must be a string.", path: ["taskId"] }],
    });
  });

  it("tells the model a send uses the tool's input schema too", async () => {
    const result = await validate(wrapped(), { taskId: "notes-abc234" });

    expect(result.issues?.at(-1)).toEqual({ message: SEND_INPUT_SCHEMA_HINT });
    expect(result.issues?.length).toBeGreaterThan(1);
  });

  it("still refuses a schema that is not an object or already declares taskId", () => {
    expect(() => serializeInputSchema(wrapped(defineJsonSchema({ type: "string" })))).toThrow(
      "A resumable tool's inputSchema must describe an object",
    );
    expect(() =>
      serializeInputSchema(
        wrapped(defineJsonSchema({ properties: { taskId: { type: "number" } }, type: "object" })),
      ),
    ).toThrow('A resumable tool\'s inputSchema cannot declare "taskId"');
  });

  it("refuses a value that is not a tool schema instead of leaving taskId out", () => {
    expect(() => withTaskIdParameter({ type: "object" })).toThrow(
      "A resumable tool's input schema must be an eve tool schema to take taskId.",
    );
  });
});

describe("resumableInputSchemaError", () => {
  it("accepts an object schema, or one that leaves its type out", () => {
    expect(resumableInputSchemaError({ properties: { request: {} }, type: "object" })).toBe(
      undefined,
    );
    expect(resumableInputSchemaError({})).toBeUndefined();
  });

  it("says why a schema cannot take taskId", () => {
    expect(resumableInputSchemaError({ type: "array" })).toBe(
      'A resumable tool\'s inputSchema must describe an object, because eve adds "taskId" to it for sends to the tool\'s tasks; this one has type "array".',
    );
    expect(resumableInputSchemaError({ properties: { taskId: {} }, type: "object" })).toBe(
      "A resumable tool's inputSchema cannot declare \"taskId\", because eve adds it for sends to the tool's tasks; rename that property.",
    );
  });
});
