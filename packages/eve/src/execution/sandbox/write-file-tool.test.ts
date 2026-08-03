import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file-tool.js";
import { executeWriteFileOnSandbox } from "#execution/sandbox/write-file-tool.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const HOME_SKILL_FILE = "/home/agent/.agents/skills/research/references/catalog.md";
const WORKSPACE_SKILL_PATH = "/workspace/skills/research/references/catalog.md";

describe("executeWriteFileOnSandbox skill-root consistency", () => {
  it("edits the same file read_file served instead of a divergent shadow copy", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        [HOME_SKILL_FILE]: "before\n",
      },
    });

    const result = await contextStorage.run(new ContextContainer(), async () => {
      // read_file serves the home-root copy from the /workspace/skills path...
      await executeReadFileOnSandbox(sandbox.session, { filePath: WORKSPACE_SKILL_PATH });
      // ...and write_file must update that same file, not create a shadow.
      return executeWriteFileOnSandbox(sandbox.session, {
        filePath: WORKSPACE_SKILL_PATH,
        content: "after\n",
      });
    });

    expect(result).toEqual({ existed: true, path: HOME_SKILL_FILE });
    await expect(sandbox.session.readTextFile({ path: HOME_SKILL_FILE })).resolves.toBe("after\n");
    // No shadow copy is written under the /workspace/skills root.
    await expect(sandbox.session.readTextFile({ path: WORKSPACE_SKILL_PATH })).resolves.toBeNull();
  });

  it("creates a new skill file at the home-first candidate", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    const result = await contextStorage.run(new ContextContainer(), () =>
      executeWriteFileOnSandbox(sandbox.session, {
        filePath: WORKSPACE_SKILL_PATH,
        content: "fresh\n",
      }),
    );

    expect(result).toEqual({ existed: false, path: HOME_SKILL_FILE });
    await expect(sandbox.session.readTextFile({ path: HOME_SKILL_FILE })).resolves.toBe("fresh\n");
  });
});
