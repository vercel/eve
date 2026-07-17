import { describe, expect, it } from "vitest";

import {
  ASK_QUESTION_INPUT_SCHEMA,
  ASK_QUESTION_TOOL_DEFINITION,
} from "#runtime/framework-tools/ask-question.js";
import { serializeInputSchema } from "#shared/tool-schema.js";

describe("ASK_QUESTION_INPUT_SCHEMA", () => {
  it("is derived from the input request schema", () => {
    expect(serializeInputSchema(ASK_QUESTION_INPUT_SCHEMA)).toEqual({
      additionalProperties: false,
      properties: {
        allowFreeform: {
          description:
            "Whether the user may answer with freeform text instead of selecting one of the provided options.",
          type: "boolean",
        },
        options: {
          description: "Selectable answer options to present to the user.",
          items: {
            additionalProperties: false,
            properties: {
              description: {
                description: "Optional additional context for this option.",
                type: "string",
              },
              id: {
                description: "Stable identifier for the option.",
                type: "string",
              },
              label: {
                description: "User-facing label for the option.",
                type: "string",
              },
              style: {
                description: "Visual treatment hint for the option.",
                enum: ["primary", "danger", "default"],
                type: "string",
              },
            },
            required: ["id", "label"],
            type: "object",
          },
          type: "array",
        },
        prompt: {
          description: "The prompt to present to the user.",
          type: "string",
        },
      },
      required: ["prompt"],
      type: "object",
    });
    expect(ASK_QUESTION_TOOL_DEFINITION.inputSchema).toBe(ASK_QUESTION_INPUT_SCHEMA);
  });
});
