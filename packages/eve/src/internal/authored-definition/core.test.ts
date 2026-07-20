import { describe, expect, it } from "vitest";

import {
  normalizeAgentDefinition,
  normalizeScheduleDefinition,
} from "#internal/authored-definition/core.js";
import { defineDynamic } from "#public/definitions/tool.js";

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

  it("accepts dynamic model definitions", () => {
    const model = defineDynamic({
      fallback: "openai/gpt-5.5",
      events: {
        "session.started": () => "openai/gpt-5.5-mini",
      },
    });
    const definition = normalizeAgentDefinition(
      {
        model,
      },
      FAILURE_MESSAGE,
    );

    expect(definition.model).toMatchObject({
      fallback: "openai/gpt-5.5",
      kind: "eve:dynamic",
    });
    expect(typeof (definition.model as typeof model).events["session.started"]).toBe("function");
  });

  it("rejects a dynamic model without a fallback", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: defineDynamic({
            events: {
              "session.started": () => "openai/gpt-5.5-mini",
            },
          }),
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('Dynamic model definitions must include a "fallback" model.');
  });

  it("rejects a dynamic compaction model", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          compaction: {
            model: defineDynamic({
              fallback: "openai/gpt-5.5-mini",
              events: {
                "session.started": () => "openai/gpt-5.5-mini",
              },
            }),
          },
          model: "openai/gpt-5.5",
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('"compaction.model" does not support defineDynamic');
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

  it("accepts positive agent limits", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        limits: {
          maxInputTokensPerSession: 200_000,
          maxOutputTokensPerSession: 20_000,
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.limits).toEqual({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
    });
  });

  it("accepts false to uncap session token limits", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        limits: {
          maxInputTokensPerSession: false,
          maxOutputTokensPerSession: false,
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.limits).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: false,
    });
  });

  it("rejects the removed subagent max depth limit", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          limits: { maxSubagentDepth: 4 },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

  it("rejects the removed agent-level workflow max subagents limit", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          limits: { maxSubagents: 6 },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

  it.each([
    ["maxInputTokensPerSession", 0],
    ["maxInputTokensPerSession", 1.5],
    ["maxInputTokensPerSession", -1],
    ["maxInputTokensPerSession", "200000"],
    ["maxOutputTokensPerSession", 0],
    ["maxOutputTokensPerSession", 1.5],
    ["maxOutputTokensPerSession", -1],
    ["maxOutputTokensPerSession", "20000"],
  ])("rejects invalid session token limit %s=%j", (key, value) => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          limits: { [key]: value },
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
