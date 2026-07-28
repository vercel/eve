import { describe, expect, it } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  FALLBACK_SKILL_ROOT,
  MODEL_SKILL_ROOT,
  formatFallbackSkillPath,
  formatSkillModelPath,
  resolveSandboxSeedFilePath,
  resolveSandboxSkillReadPaths,
  resolveSandboxSkillRoot,
  resolveSkillFilePathCandidates,
} from "#shared/skill-paths.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

describe("skill path helpers", () => {
  it("formats model-facing and fallback skill paths", () => {
    expect(formatSkillModelPath({ name: "research", relativePath: "SKILL.md" })).toBe(
      `${MODEL_SKILL_ROOT}/research/SKILL.md`,
    );
    expect(formatFallbackSkillPath({ name: "research", relativePath: "SKILL.md" })).toBe(
      `${FALLBACK_SKILL_ROOT}/research/SKILL.md`,
    );
  });

  it("resolves the sandbox skill root from HOME", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/home/agent/.agents/skills",
    );
    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/home/agent/.agents/skills",
    );
    expect(sandbox.commandLog).toEqual([HOME_PROBE_COMMAND]);
  });

  it("falls back to /workspace/skills when HOME is unusable", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "\n" },
      },
    });

    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      FALLBACK_SKILL_ROOT,
    );
  });

  it("reads only from the resolved HOME skill root when HOME is usable", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    await expect(
      resolveSandboxSkillReadPaths({
        name: "research",
        relativePath: "SKILL.md",
        sandbox: sandbox.session,
      }),
    ).resolves.toEqual(["/home/agent/.agents/skills/research/SKILL.md"]);
  });

  it("reads from /workspace/skills only when that root is selected", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "\n" },
      },
    });

    await expect(
      resolveSandboxSkillReadPaths({
        name: "research",
        relativePath: "SKILL.md",
        sandbox: sandbox.session,
      }),
    ).resolves.toEqual(["/workspace/skills/research/SKILL.md"]);
  });

  it("resolves model-facing seed paths before writing to the sandbox", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    await expect(
      resolveSandboxSeedFilePath({
        path: `${MODEL_SKILL_ROOT}/research/references/catalog.md`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/home/agent/.agents/skills/research/references/catalog.md");
  });

  describe("resolveSkillFilePathCandidates", () => {
    it("orders the HOME root before the /workspace fallback for a workspace skill path", async () => {
      const sandbox = mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
      });

      await expect(
        resolveSkillFilePathCandidates({
          path: `${FALLBACK_SKILL_ROOT}/research/references/notes.md`,
          sandbox: sandbox.session,
        }),
      ).resolves.toEqual([
        "/home/agent/.agents/skills/research/references/notes.md",
        "/workspace/skills/research/references/notes.md",
      ]);
    });

    it("resolves the symbolic $HOME skill path to concrete candidates", async () => {
      const sandbox = mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
      });

      await expect(
        resolveSkillFilePathCandidates({
          path: `${MODEL_SKILL_ROOT}/research/SKILL.md`,
          sandbox: sandbox.session,
        }),
      ).resolves.toEqual([
        "/home/agent/.agents/skills/research/SKILL.md",
        "/workspace/skills/research/SKILL.md",
      ]);
    });

    it("collapses to the /workspace fallback when HOME is unusable", async () => {
      const sandbox = mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "\n" },
        },
      });

      await expect(
        resolveSkillFilePathCandidates({
          path: `${MODEL_SKILL_ROOT}/research/SKILL.md`,
          sandbox: sandbox.session,
        }),
      ).resolves.toEqual(["/workspace/skills/research/SKILL.md"]);
    });

    it("passes non-skill paths through unchanged without probing HOME", async () => {
      const sandbox = mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
      });

      await expect(
        resolveSkillFilePathCandidates({
          path: "/workspace/src/index.ts",
          sandbox: sandbox.session,
        }),
      ).resolves.toEqual(["/workspace/src/index.ts"]);
      expect(sandbox.commandLog).toEqual([]);
    });

    it("keeps a distinct concrete home path as a candidate after the resolved root", async () => {
      const sandbox = mockSandbox({
        commands: {
          [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
        },
      });

      await expect(
        resolveSkillFilePathCandidates({
          path: "/root/.agents/skills/research/SKILL.md",
          sandbox: sandbox.session,
        }),
      ).resolves.toEqual([
        "/home/agent/.agents/skills/research/SKILL.md",
        "/root/.agents/skills/research/SKILL.md",
        "/workspace/skills/research/SKILL.md",
      ]);
    });
  });
});
