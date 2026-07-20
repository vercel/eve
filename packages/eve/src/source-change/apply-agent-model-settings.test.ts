import { describe, expect, it } from "vitest";

import { checkAgentConfigSource } from "./agent-config-string-path.js";
import { applyAgentModelSettingsToSource, type FieldPatch } from "./apply-agent-model-settings.js";

const keep = { kind: "keep" } as const;
const remove = { kind: "remove" } as const;
const set = <T>(value: T): FieldPatch<T> => ({ kind: "set", value });

const SCAFFOLD = `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`;

describe("applyAgentModelSettingsToSource", () => {
  it("applies model, reasoning, and Fast mode in one in-memory edit", async () => {
    const result = await applyAgentModelSettingsToSource(SCAFFOLD, {
      model: set("openai/gpt-5.5"),
      reasoning: set("high"),
      gatewayServiceTier: set("priority"),
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.changed).toEqual(["model", "reasoning", "fast-mode"]);
    expect(result.nextSource).toContain('model: "openai/gpt-5.5"');
    expect(result.nextSource).toContain('reasoning: "high"');
    expect(result.nextSource).toContain(
      'modelOptions: { providerOptions: { gateway: { serviceTier: "priority" } } }',
    );
  });

  it("preserves sibling Gateway and provider options", async () => {
    const source = `export default defineAgent({
  model: "a/b",
  modelOptions: {
    providerOptions: {
      gateway: { byok: "anthropic", caching: "auto" },
      anthropic: { thinking: { type: "adaptive" } },
    },
  },
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: keep,
      reasoning: keep,
      gatewayServiceTier: set("priority"),
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain('byok: "anthropic"');
    expect(result.nextSource).toContain('caching: "auto"');
    expect(result.nextSource).toContain('anthropic: { thinking: { type: "adaptive" } }');
    expect(result.nextSource).toContain('serviceTier: "priority"');
  });

  it("removes provider-default reasoning and only the priority tier", async () => {
    const source = `export default defineAgent({
  model: "a/b",
  reasoning: "high",
  modelOptions: {
    providerOptions: {
      gateway: { byok: "anthropic", serviceTier: "priority" },
    },
  },
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: keep,
      reasoning: remove,
      gatewayServiceTier: remove,
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).not.toContain("reasoning:");
    expect(result.nextSource).not.toContain("serviceTier:");
    expect(result.nextSource).toContain('byok: "anthropic"');
  });

  it("prunes wrappers emptied by disabling Fast mode", async () => {
    const source = `export default defineAgent({
  model: "a/b",
  modelOptions: { providerOptions: { gateway: { serviceTier: "priority" } } },
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: keep,
      reasoning: keep,
      gatewayServiceTier: remove,
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).not.toContain("modelOptions");
    expect(result.nextSource).toContain('model: "a/b"');
  });

  it("refuses to overwrite a custom service tier", async () => {
    const source = `export default defineAgent({
  model: "a/b",
  modelOptions: { providerOptions: { gateway: { serviceTier: "flex" } } },
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: keep,
      reasoning: keep,
      gatewayServiceTier: remove,
    });

    expect(result).toMatchObject({ kind: "bail", reason: expect.stringContaining("custom") });
  });

  it("bails without returning a partial edit for unsafe nested source", async () => {
    const source = `export default defineAgent({
  model: "a/b",
  modelOptions: getModelOptions(),
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: set("c/d"),
      reasoning: set("high"),
      gatewayServiceTier: set("priority"),
    });

    expect(result).toMatchObject({ kind: "bail" });
    expect("nextSource" in result).toBe(false);
  });

  it("refuses explicit settings when a spread can override their value", async () => {
    const source = `export default defineAgent({
  model: "a/b",
  reasoning: "low",
  ...sharedSettings,
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: keep,
      reasoning: set("high"),
      gatewayServiceTier: keep,
    });

    expect(result).toMatchObject({ kind: "bail", reason: expect.stringContaining("spread") });
    expect("nextSource" in result).toBe(false);
  });

  it("empties the braces when removing a sole property with a trailing comma", async () => {
    for (const source of [
      'export default defineAgent({ reasoning: "high", });\n',
      'export default defineAgent({\n  reasoning: "high",\n});\n',
    ]) {
      const result = await applyAgentModelSettingsToSource(source, {
        model: keep,
        reasoning: remove,
        gatewayServiceTier: keep,
      });

      expect(result.kind).toBe("applied");
      if (result.kind !== "applied") return;
      // Slicing out only the property used to strand its trailing comma as
      // `defineAgent({ , })` — unparseable source written to agent.ts.
      expect(result.nextSource).not.toContain(",");
      await expect(checkAgentConfigSource(result.nextSource)).resolves.toBeUndefined();
    }
  });

  it("prunes a sole modelOptions chain without stranding its trailing comma", async () => {
    const source = `export default defineAgent({
  modelOptions: {
    providerOptions: {
      gateway: { serviceTier: "priority" },
    },
  },
});
`;
    const result = await applyAgentModelSettingsToSource(source, {
      model: keep,
      reasoning: keep,
      gatewayServiceTier: remove,
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).not.toContain("modelOptions");
    await expect(checkAgentConfigSource(result.nextSource)).resolves.toBeUndefined();
  });
});

describe("checkAgentConfigSource", () => {
  it("accepts a sound config and names the failure for a broken one", async () => {
    await expect(
      checkAgentConfigSource('export default defineAgent({ model: "a/b" });'),
    ).resolves.toBeUndefined();

    await expect(checkAgentConfigSource("export default defineAgent({ , });")).resolves.toContain(
      "parse",
    );

    await expect(checkAgentConfigSource("const x = 1;")).resolves.toContain("defineAgent");
  });
});
