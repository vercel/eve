import { describe, expect, it } from "vitest";

import {
  normalizeAgentDefinition,
  normalizeInstructionsDefinition,
  normalizeScheduleDefinition,
} from "#internal/authored-definition/core.js";
import { defineDynamic } from "#dynamic/definition.js";

const FAILURE_MESSAGE = "Expected the agent config to match the public eve shape.";

describe("normalizeAgentDefinition", () => {
  it("normalizes agent tool visibility", () => {
    expect(
      normalizeAgentDefinition({ model: "openai/gpt-5.5", tool: false }, FAILURE_MESSAGE).tool,
    ).toBe(false);
    expect(() =>
      normalizeAgentDefinition({ model: "openai/gpt-5.5", tool: "no" }, FAILURE_MESSAGE),
    ).toThrow(FAILURE_MESSAGE);
  });

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

  it("accepts a dynamic model field beside static fields", () => {
    const model = defineDynamic({ select: () => null, resolve: () => "openai/gpt-5.5-mini" });
    const definition = normalizeAgentDefinition({ defaultTools: false, model }, FAILURE_MESSAGE);

    expect(definition.defaultTools).toBe(false);
    expect(definition.model).toBe(model);
  });

  it("rejects a dynamic agent.ts, pointing at the dynamic model field", () => {
    expect(() =>
      normalizeAgentDefinition(
        defineDynamic({ select: () => null, resolve: () => ({ model: "openai/gpt-5.5-mini" }) }),
        FAILURE_MESSAGE,
      ),
    ).toThrow(/make the model field dynamic/);
  });

  it("rejects model settings beside a dynamic model", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: defineDynamic({ select: () => null, resolve: () => "openai/gpt-5.5-mini" }),
          modelContextWindowTokens: 128_000,
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(/returns its "modelContextWindowTokens" and "modelOptions" from resolve/);
  });

  it("rejects keys beside a dynamic model's select and resolve", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: {
            ...defineDynamic({ select: () => null, resolve: () => "openai/gpt-5.5-mini" }),
            reasoning: "high",
          },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(/takes only select and resolve. Unknown key\(s\): reasoning/);
  });

  it("rejects a dynamic compaction model", () => {
    expect(() =>
      normalizeAgentDefinition(
        {
          compaction: {
            model: defineDynamic({
              select: () => null,
              resolve: () => "openai/gpt-5.5-mini",
            }),
          },
          model: "openai/gpt-5.5",
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('"compaction.model" does not support defineDynamic');
  });

  it("accepts Anthropic prompt cache options", () => {
    const definition = normalizeAgentDefinition(
      { model: "openai/gpt-5.5", modelOptions: { promptCache: { anthropic: { ttl: "1h" } } } },
      FAILURE_MESSAGE,
    );

    expect(definition.modelOptions).toEqual({ promptCache: { anthropic: { ttl: "1h" } } });
  });

  it("rejects an unsupported Anthropic prompt cache TTL", () => {
    expect(() =>
      normalizeAgentDefinition(
        { model: "openai/gpt-5.5", modelOptions: { promptCache: { anthropic: { ttl: "24h" } } } },
        FAILURE_MESSAGE,
      ),
    ).toThrow('"modelOptions.promptCache.anthropic.ttl" must be "5m" or "1h"; received "24h".');
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
          maxTokenCostUsdPerSession: 1.5,
          sessionTimeoutMs: 86_400_000,
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.limits).toEqual({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
      maxTokenCostUsdPerSession: 1.5,
      sessionTimeoutMs: 86_400_000,
    });
  });

  it("accepts false to uncap session token limits", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        limits: {
          maxInputTokensPerSession: false,
          maxOutputTokensPerSession: false,
          maxTokenCostUsdPerSession: false,
          sessionTimeoutMs: false,
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.limits).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: false,
      maxTokenCostUsdPerSession: false,
      sessionTimeoutMs: false,
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
    ["maxTokenCostUsdPerSession", 0],
    ["maxTokenCostUsdPerSession", -0.01],
    ["maxTokenCostUsdPerSession", Number.POSITIVE_INFINITY],
    ["maxTokenCostUsdPerSession", "1.50"],
    ["sessionTimeoutMs", 0],
    ["sessionTimeoutMs", 1.5],
    ["sessionTimeoutMs", -1],
    ["sessionTimeoutMs", "30d"],
  ])("rejects invalid session runtime limit %s=%j", (key, value) => {
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

  it("accepts a positive model-call batch size", () => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        experimental: {
          workflow: {
            modelCallsPerStep: 4,
          },
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.experimental?.workflow?.modelCallsPerStep).toBe(4);
  });

  it.each([0, 1.5, -1, Number.POSITIVE_INFINITY, "4"])(
    "rejects invalid model-call batch size %j",
    (value) => {
      expect(() =>
        normalizeAgentDefinition(
          {
            model: "openai/gpt-5.5",
            experimental: {
              workflow: {
                modelCallsPerStep: value,
              },
            },
          },
          FAILURE_MESSAGE,
        ),
      ).toThrow(FAILURE_MESSAGE);
    },
  );

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

  it.each([0, "default"] as const)("accepts workflow retention %j", (value) => {
    const definition = normalizeAgentDefinition(
      {
        model: "openai/gpt-5.5",
        experimental: {
          workflow: {
            retention: value,
          },
        },
      },
      FAILURE_MESSAGE,
    );

    expect(definition.experimental?.workflow?.retention).toBe(value);
  });

  it.each(["none", "0", 1, true, null])("rejects invalid workflow retention %j", (value) => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          experimental: {
            workflow: {
              retention: value,
            },
          },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('"experimental.workflow.retention" must be 0 or "default"');
  });

  it.each([true, false])("rejects the removed subagentPersistentSessions flag", (value) => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          experimental: {
            subagentPersistentSessions: value,
          },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('Unknown key "subagentPersistentSessions"');
  });

  it.each([true, false, "yes"])("rejects the removed tasks flag", (tasks) => {
    expect(() =>
      normalizeAgentDefinition(
        {
          model: "openai/gpt-5.5",
          experimental: {
            tasks,
          },
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('Unknown key "tasks"');
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

describe("normalizeInstructionsDefinition", () => {
  const message = "Expected instructions to match the public eve shape.";

  it("normalizes content with a default system role", () => {
    expect(normalizeInstructionsDefinition({ content: "Be concise." }, message)).toEqual({
      content: "Be concise.",
      role: "system",
    });
  });

  it("accepts user-role content", () => {
    expect(
      normalizeInstructionsDefinition({ content: "Tenant context.", role: "user" }, message),
    ).toEqual({ content: "Tenant context.", role: "user" });
  });

  it("normalizes the deprecated markdown shape as system content", () => {
    expect(normalizeInstructionsDefinition({ markdown: "Legacy." }, message)).toEqual({
      content: "Legacy.",
      role: "system",
    });
  });

  it.each([
    { content: "mixed", markdown: "mixed" },
    { content: "invalid", role: "assistant" },
    { markdown: "legacy", role: "system" },
    { content: "unknown", extra: true },
    {},
  ])("rejects invalid instructions definitions %#", (definition) => {
    expect(() => normalizeInstructionsDefinition(definition, message)).toThrow(message);
  });
});
