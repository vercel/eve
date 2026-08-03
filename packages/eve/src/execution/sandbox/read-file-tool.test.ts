import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file-tool.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function readInContext(
  sandbox: ReturnType<typeof mockSandbox>,
  filePath: string,
): Promise<{ content: string; path: string }> {
  return contextStorage.run(new ContextContainer(), () =>
    executeReadFileOnSandbox(sandbox.session, { filePath }),
  );
}

describe("executeReadFileOnSandbox skill-root fallback", () => {
  it("reads a skill file from the HOME root when given the /workspace/skills path", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/home/agent/.agents/skills/research/references/catalog.md": "alpha\nbeta\n",
      },
    });

    const result = await readInContext(sandbox, "/workspace/skills/research/references/catalog.md");

    expect(result.path).toBe("/home/agent/.agents/skills/research/references/catalog.md");
    expect(result.content).toContain("alpha");
  });

  it("falls back to /workspace/skills when the HOME candidate is absent", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/workspace/skills/research/references/catalog.md": "gamma\n",
      },
    });

    const result = await readInContext(
      sandbox,
      "$HOME/.agents/skills/research/references/catalog.md",
    );

    expect(result.path).toBe("/workspace/skills/research/references/catalog.md");
    expect(result.content).toContain("gamma");
  });
});
