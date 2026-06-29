import { describe, expect, it } from "vitest";

import {
  normalizeAgentDefinition,
  normalizeScheduleDefinition,
} from "#internal/authored-definition/core.js";

const FAILURE_MESSAGE = "Expected the agent config to match the public eve shape.";

describe("normalizeAgentDefinition", () => {
  it("accepts provider-agnostic reasoning effort", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        reasoning: "high",
      },
      FAILURE_MESSAGE,
    );

    expect(definition.reasoning).toBe("high");
  });

  it("rejects unsupported reasoning effort", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          reasoning: "maximum",
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

  it("accepts a positive subagent max depth", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        limits: { maxSubagentDepth: 4 },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.limits).toEqual({ maxSubagentDepth: 4 });
  });

  it.each([0, 1.5, -1, "4"])("rejects invalid subagent max depth %j", (maxSubagentDepth) => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          limits: { maxSubagentDepth },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

  it("rejects the old subagents maxDepth config", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          subagents: { maxDepth: 4 },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

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

describe("normalizeScheduleDefinition", () => {
  it.each(["approval", "needsApproval"])("rejects the removed %s field", (field) => {
    expect(() =>
      normalizeScheduleDefinition(
        {
          cron: "0 9 * * *",
          markdown: "Send a digest.",
          [field]: () => "user-approval",
        },
        "Expected the schedule config to match the public eve shape.",
      ),
    ).toThrow(`Unknown key "${field}"`);
  });
});
