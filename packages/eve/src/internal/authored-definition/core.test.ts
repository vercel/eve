import { describe, expect, it } from "vitest";

import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";

const FAILURE_MESSAGE = "Expected the agent config to match the public eve shape.";

describe("normalizeAgentDefinition", () => {
  it("accepts a workflow world package name", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        experimental: {
          workflow: {
            world: "@workflow/world-postgres",
          },
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.experimental?.workflow).toEqual({ world: "@workflow/world-postgres" });
  });

  it("rejects non-string workflow world values", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          experimental: {
            workflow: {
              world: {
                module: "@acme/eve-world",
              },
            },
          },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

  it("rejects empty workflow world package names", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          experimental: {
            workflow: {
              world: " ",
            },
          },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('"experimental.workflow.world" must be a non-empty package name');
  });
});
