import { describe, expect, it } from "vitest";

import {
  assertSafeSkillId,
  createSandboxSkillHandle,
  loadSkillFromSandbox,
} from "#runtime/skills/sandbox-access.js";
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

describe("loadSkillFromSandbox", () => {
  it("reads SKILL.md from the sandbox and strips frontmatter", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/home/agent/.agents/skills/research/SKILL.md":
          "---\nname: research\ndescription: x\n---\n# Research\n",
      },
    });

    await expect(loadSkillFromSandbox(sandbox.access, "research")).resolves.toBe("# Research\n");
  });

  it("does not read an ordinary workspace skills subtree when HOME is usable", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/workspace/skills/research/SKILL.md": "# Research\n",
      },
    });

    await expect(loadSkillFromSandbox(sandbox.access, "research")).rejects.toThrow(
      'No skill named "research" at /home/agent/.agents/skills/research/SKILL.md.',
    );
  });

  it("reads the legacy workspace skill path when HOME is unavailable", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/research/SKILL.md": "# Research\n",
      },
    });

    await expect(loadSkillFromSandbox(sandbox.access, "research")).resolves.toBe("# Research\n");
  });

  it("throws when the skill is missing", async () => {
    const sandbox = mockSandbox();

    await expect(loadSkillFromSandbox(sandbox.access, "missing")).rejects.toThrow(
      'No skill named "missing"',
    );
  });

  it("lists available skill names when the requested id is missing", async () => {
    const sandbox = mockSandbox();

    await expect(
      loadSkillFromSandbox(sandbox.access, "talk-like-a-dog", [
        "custom__talk-like-a-dog",
        "research",
      ]),
    ).rejects.toThrow("Available skills: custom__talk-like-a-dog, research.");
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
});
