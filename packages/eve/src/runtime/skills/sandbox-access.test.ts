import { describe, expect, it, vi } from "vitest";

import { assertSafeSkillId, createSandboxSkillHandle } from "#runtime/skills/sandbox-access.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

describe("assertSafeSkillId", () => {
  it("accepts path-derived skill ids", () => {
    expect(() => assertSafeSkillId("research-skill")).not.toThrow();
    expect(() => assertSafeSkillId("research_skill")).not.toThrow();
  });

  it("rejects unsafe path segments", () => {
    for (const value of ["", " skill", ".skill", "../skill", "a/b", "a\\b", "C:skill"]) {
      expect(() => assertSafeSkillId(value)).toThrow("Expected skill id");
    }
  });
});

describe("createSandboxSkillHandle", () => {
  it("reads text and bytes relative to the skill root", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/home/agent/.agents/skills/research/references/catalog.yml": "entities: []\n",
      },
    });
    const handle = createSandboxSkillHandle(sandbox.access, "research");

    expect(handle.name).toBe("research");
    await expect(handle.file("references/catalog.yml").text()).resolves.toBe("entities: []\n");
    await expect(handle.file("references/catalog.yml").bytes()).resolves.toEqual(
      Buffer.from("entities: []\n"),
    );
  });

  it("serves SKILL.md from in-memory instructions without opening the sandbox", async () => {
    const get = vi.fn(async () => null);
    const access = { captureState: async () => ({ session: null }), get, stop: async () => {} };
    const handle = createSandboxSkillHandle(
      access,
      "policy",
      () => "---\nname: policy\n---\n# Policy\n",
    );

    await expect(handle.file("SKILL.md").text()).resolves.toBe(
      "---\nname: policy\n---\n# Policy\n",
    );
    await expect(handle.file("SKILL.md").bytes()).resolves.toEqual(
      new TextEncoder().encode("---\nname: policy\n---\n# Policy\n"),
    );
    expect(get).not.toHaveBeenCalled();
    await expect(handle.file("references/rules.md").text()).rejects.toThrow(
      "The sandbox is not available",
    );
  });

  it("reads SKILL.md from the sandbox when no in-memory instructions exist", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: { "/home/agent/.agents/skills/research/SKILL.md": "# Research\n" },
    });
    const handle = createSandboxSkillHandle(sandbox.access, "research", () => undefined);

    await expect(handle.file("SKILL.md").text()).resolves.toBe("# Research\n");
  });
});
