import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { SKILL_TOOL_DEFINITION } from "#runtime/framework-tools/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

// Mirrors the helper in dynamic-skill-lifecycle.test.ts: a CompiledBundle is
// large and mostly irrelevant here, so unused fields are stubbed `as never`
// (the established guard-clean pattern) and only resolvedAgent.skills is real.
function mockBundleWithSkills(skillNames: readonly string[]): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      skills: skillNames.map((name) => ({ name })),
    } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

describe("SKILL_TOOL_DEFINITION", () => {
  it("describes when skill loading should be used", () => {
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "request clearly matches a listed skill description",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "Loading adds the skill instructions to the current turn.",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain("Available skills block");
  });
});

describe("load_skill executor", () => {
  it("surfaces authored and dynamic skill names when the requested id is missing", async () => {
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, mockSandbox().access);
    ctx.set(BundleKey, mockBundleWithSkills(["research"]));
    ctx.set(DynamicSkillManifestKey, {
      custom: [{ description: "Talk like a dog", name: "custom__talk-like-a-dog" }],
    });

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () => execute({ skill: "talk-like-a-dog" })),
    ).rejects.toThrow("Available skills: custom__talk-like-a-dog, research.");
  });
});
