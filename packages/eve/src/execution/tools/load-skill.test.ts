import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { loadSkill } from "#public/tools/load-skill.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createSandboxSkillHandle } from "#runtime/skills/sandbox-access.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";

function skillToolExecutor(ctx: ContextContainer, skills: readonly ResolvedSkillDefinition[] = []) {
  ctx.set(BundleKey, {
    resolvedAgent: { skills },
  } as never);
  const execute = loadSkill.execute;
  if (execute === undefined) throw new Error("load_skill tool is missing an execute function");
  return execute;
}

describe("loadSkill", () => {
  it("describes when skill loading should be used", () => {
    expect(loadSkill.description).toContain("request clearly matches a listed skill description");
    expect(loadSkill.description).toContain(
      "Loading adds the skill instructions to the current turn.",
    );
    expect(loadSkill.description).toContain("Available skills block");
    expect(loadSkill.description).not.toContain("connection_search");
  });
});

describe("load_skill executor", () => {
  it("loads an authored markdown skill from the active compiled bundle", async () => {
    const ctx = new ContextContainer();
    const execute = skillToolExecutor(ctx, [
      {
        description: "Research a topic systematically",
        logicalPath: "skills/research.md",
        markdown: "# Research\n\nFollow the evidence.\n",
        name: "research",
        sourceId: "skills/research.md",
        sourceKind: "markdown",
      },
      {
        description: "Write a concise summary",
        logicalPath: "skills/summarize.md",
        markdown: "# Summarize\n",
        name: "summarize",
        sourceId: "skills/summarize.md",
        sourceKind: "markdown",
      },
    ]);

    await expect(
      contextStorage.run(ctx, () => execute({ skill: "research" }, {} as never)),
    ).resolves.toBe("# Research\n\nFollow the evidence.\n");
  });

  it("opens the sandbox only when a loaded static skill's sibling file is read", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/incident-response/references/services/api/owners.md": "# API owners\n",
      },
    });
    const get = vi.fn(async () => sandbox.session);
    const access = {
      captureState: vi.fn(async () => ({ initialized: false, session: null })),
      get,
      stop: vi.fn(async () => {}),
    };
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    const execute = skillToolExecutor(ctx, [
      {
        assetsPath: "/authored/skills/incident-response/assets",
        description: "Run the full incident response procedure",
        logicalPath: "skills/incident-response/SKILL.md",
        markdown:
          "# Incident response\n\nConsult `references/services/api/owners.md` when needed.\n",
        name: "incident-response",
        referencesPath: "/authored/skills/incident-response/references",
        rootPath: "/authored/skills/incident-response",
        scriptsPath: "/authored/skills/incident-response/scripts",
        skillFilePath: "/authored/skills/incident-response/SKILL.md",
        skillId: "incident-response",
        sourceId: "skills/incident-response/SKILL.md",
        sourceKind: "skill-package",
      },
    ]);

    await expect(
      contextStorage.run(ctx, () => execute({ skill: "incident-response" }, {} as never)),
    ).resolves.toBe(
      "# Incident response\n\nConsult `references/services/api/owners.md` when needed.\n",
    );
    expect(get).not.toHaveBeenCalled();

    const skill = createSandboxSkillHandle(access, "incident-response");
    await expect(skill.file("references/services/api/owners.md").text()).resolves.toBe(
      "# API owners\n",
    );
    expect(get).toHaveBeenCalledOnce();
  });

  it("loads an active dynamic skill from the sandbox instead of a same-named authored skill", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/policy/SKILL.md": "# Dynamic policy\n",
      },
    });
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, sandbox.access);
    ctx.set(DynamicSkillManifestKey, {
      policy: [{ description: "Apply the dynamic policy", name: "policy" }],
    });
    const execute = skillToolExecutor(ctx, [
      {
        description: "Apply the static policy",
        logicalPath: "skills/policy.md",
        markdown: "# Static policy\n",
        name: "policy",
        sourceId: "skills/policy.md",
        sourceKind: "markdown",
      },
    ]);

    await expect(
      contextStorage.run(ctx, () => execute({ skill: "policy" }, {} as never)),
    ).resolves.toBe("# Dynamic policy\n");
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
    const execute = skillToolExecutor(ctx);

    await expect(
      contextStorage.run(ctx, () => execute({ skill: "talk-like-a-dog" }, {} as never)),
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
    const execute = skillToolExecutor(ctx);

    await expect(
      contextStorage.run(ctx, () => execute({ skill: "linear" }, {} as never)),
    ).rejects.toThrow(
      '"linear" is an installed connection, not a skill. Use connection_search with connection "linear" to find its tools.',
    );
  });
});
