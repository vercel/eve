import { describe, expect, it } from "vitest";

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
});
