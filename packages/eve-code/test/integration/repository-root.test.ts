import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxSession } from "eve/sandbox";

import { validateRepositoryRoot } from "../../extension/lib/repository-root.ts";

test("accepts a git root inside the sandbox workspace", async () => {
  const sandbox = rootSandbox("/workspace/repo");
  assert.equal(await validateRepositoryRoot(sandbox, "/workspace/repo"), "/workspace/repo");
});

test("rejects roots outside the workspace and nested git paths", async () => {
  await assert.rejects(
    validateRepositoryRoot(rootSandbox("/outside/repo"), "/outside/repo"),
    /inside the sandbox workspace/u,
  );
  await assert.rejects(
    validateRepositoryRoot(rootSandbox("/workspace/repo", "/workspace"), "/workspace/repo"),
    /not a git work tree root/u,
  );
});

function rootSandbox(
  resolvedRoot: string,
  gitTop = resolvedRoot,
): Pick<SandboxSession, "resolvePath" | "run"> {
  return {
    resolvePath() {
      return "/workspace";
    },
    async run({ command }) {
      if (command.includes("realpath") && command.includes(`'${resolvedRoot}'`)) {
        return { exitCode: 0, stdout: `${resolvedRoot}\n`, stderr: "" };
      }
      if (command.includes("realpath")) {
        return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
      }
      return { exitCode: 0, stdout: `${gitTop}\n`, stderr: "" };
    },
  };
}
