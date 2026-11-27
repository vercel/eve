import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import { withSessionFastPaths } from "#execution/sandbox/internal-shell.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  MODEL_HOST_SKILL_ROOT,
  MODEL_SKILL_ROOT,
  resolveSandboxModelPath,
  resolveSandboxSkillRoot,
} from "#shared/skill-paths.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

describe("skill path helpers", () => {
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

  it("expands a leading $HOME in model-supplied paths", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent/\n" },
      },
    });

    await expect(
      resolveSandboxModelPath({ path: "$HOME/notes/todo.md", sandbox: sandbox.session }),
    ).resolves.toBe("/home/agent/notes/todo.md");
    await expect(
      resolveSandboxModelPath({ path: "$HOME", sandbox: sandbox.session }),
    ).resolves.toBe("/home/agent");
    expect(sandbox.commandLog).toEqual([HOME_PROBE_COMMAND]);
  });

  it("does not treat lookalike variables or embedded $HOME as home paths", async () => {
    const sandbox = mockSandbox();

    await expect(
      resolveSandboxModelPath({ path: "$HOME_DIR/notes.md", sandbox: sandbox.session }),
    ).resolves.toBe("$HOME_DIR/notes.md");
    await expect(
      resolveSandboxModelPath({ path: "/workspace/$HOME/notes.md", sandbox: sandbox.session }),
    ).resolves.toBe("/workspace/$HOME/notes.md");
    expect(sandbox.commandLog).toEqual([]);
  });

  it("falls back to skills/ under the workspace root when HOME is unusable", async () => {
    const { session } = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "\n" },
      },
    });
    const sandbox = { ...session, resolvePath: (path: string) => posix.resolve("/srv/app", path) };

    await expect(resolveSandboxSkillRoot({ sandbox })).resolves.toBe("/srv/app/skills");
    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_SKILL_ROOT}/research/references/catalog.md`,
        sandbox,
      }),
    ).resolves.toBe("/srv/app/skills/research/references/catalog.md");
  });

  it("resolves model-facing seed paths before writing to the sandbox", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_SKILL_ROOT}/research/references/catalog.md`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/home/agent/.agents/skills/research/references/catalog.md");
  });

  it("prefers a session fast-path skillsRoot and expands $EVE_SKILLS_DIR without shelling out", async () => {
    const sandbox = mockSandbox();
    withSessionFastPaths(sandbox.session, { skillsRoot: "/app/.eve/sandbox/host/skills/" });

    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/app/.eve/sandbox/host/skills",
    );
    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_HOST_SKILL_ROOT}/investigate/SKILL.md`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/app/.eve/sandbox/host/skills/investigate/SKILL.md");
    expect(sandbox.commandLog).toEqual([]);
  });

  it("falls back to probing $EVE_SKILLS_DIR when no session fast-path skillsRoot is attached", async () => {
    const sandbox = mockSandbox({
      commands: {
        [`printf '%s\\n' "$EVE_SKILLS_DIR"`]: {
          exitCode: 0,
          stderr: "",
          stdout: "/srv/eve-skills\n",
        },
      },
    });

    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_HOST_SKILL_ROOT}/deploy/scripts/run.sh`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/srv/eve-skills/deploy/scripts/run.sh");
    expect(sandbox.commandLog).toEqual([`printf '%s\\n' "$EVE_SKILLS_DIR"`]);
  });
});
