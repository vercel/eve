import { describe, expect, it } from "vitest";

import {
  createSubagentToolInputSchema,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";
import { serializeInputSchema } from "#tools/schema.js";

describe("createSubagentToolInputSchema", () => {
  it("keeps the default subagent input without model choices", () => {
    expect(serializeInputSchema(createSubagentToolInputSchema(undefined))).toEqual(
      serializeInputSchema(SUBAGENT_TOOL_INPUT_SCHEMA),
    );
    expect(serializeInputSchema(SUBAGENT_TOOL_INPUT_SCHEMA)).not.toHaveProperty("properties.model");
  });

  it("adds an optional model enum that defaults to the first choice", async () => {
    const schema = createSubagentToolInputSchema(["anthropic/claude-sonnet-5", "openai/gpt-5.5"]);
    expect(serializeInputSchema(schema)).toMatchObject({
      properties: {
        model: {
          default: "anthropic/claude-sonnet-5",
          enum: ["anthropic/claude-sonnet-5", "openai/gpt-5.5"],
          type: "string",
        },
      },
      required: ["message"],
    });
    expect(
      await schema["~standard"].validate({ message: "hi", model: "openai/gpt-5.5" }),
    ).not.toHaveProperty("issues");
    expect(
      await schema["~standard"].validate({ message: "hi", model: "openai/gpt-4" }),
    ).toHaveProperty("issues");
  });
});
