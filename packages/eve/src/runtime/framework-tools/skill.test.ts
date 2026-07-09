import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey, StaticSkillNamesKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";
import { SKILL_TOOL_DEFINITION } from "#runtime/framework-tools/skill.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

describe("SKILL_TOOL_DEFINITION", () => {
  it("describes when skill loading should be used", () => {
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "request clearly matches a listed skill description",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "Loading adds the skill instructions to the current turn.",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain("Available skills block");
    expect(SKILL_TOOL_DEFINITION.description).toContain("not for MCP connections");
    expect(SKILL_TOOL_DEFINITION.description).toContain("connection_search");
  });
});

describe("load_skill executor", () => {
  it("loads a static skill visible to the active agent", async () => {
    const ctx = new ContextContainer();
    ctx.set(
      SandboxKey,
      mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
        initialFiles: {
          "/home/agent/.agents/skills/parent-only/SKILL.md": "# Parent\n",
        },
      }).access,
    );
    ctx.set(StaticSkillNamesKey, ["parent-only"]);

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "parent-only" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).resolves.toBe("# Parent\n");
  });

  it("does not load static skills hidden from the active agent", async () => {
    const ctx = new ContextContainer();
    ctx.set(
      SandboxKey,
      mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
        initialFiles: {
          "/home/agent/.agents/skills/child-only/SKILL.md": "# Child\n",
        },
      }).access,
    );
    ctx.set(StaticSkillNamesKey, ["parent-only"]);

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "child-only" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).rejects.toThrow(
      'Skill "child-only" is not available to the active agent. Available skills: parent-only.',
    );
  });

  it("surfaces dynamic skill names when the requested id is missing", async () => {
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, mockSandbox().access);
    ctx.set(DynamicSkillManifestKey, {
      custom: [
        { description: "Talk like a dog", name: "custom__talk-like-a-dog" },
        { description: "Bark", name: "custom__bark" },
      ],
    });

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "talk-like-a-dog" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).rejects.toThrow("Available skills: custom__bark, custom__talk-like-a-dog.");
  });

  it("redirects an installed connection mistakenly passed as a skill", async () => {
    const registry = {
      dispose: async () => {},
      getClient: () => {
        throw new Error("Not used by load_skill");
      },
      getConnectionApproval: () => undefined,
      getConnectionNames: () => ["linear"],
      getConnections: () => [],
    } satisfies ConnectionRegistry;
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, mockSandbox().access);
    ctx.set(ConnectionRegistryKey, registry);

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "linear" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).rejects.toThrow(
      '"linear" is an installed connection, not a skill. Use connection_search with connection "linear" to find its tools.',
    );
  });
});
