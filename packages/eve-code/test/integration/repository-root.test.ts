import assert from "node:assert/strict";
import test from "node:test";

import { validateRepositoryRoot } from "../../extension/lib/repository-root.ts";
import {
  resolveInWorkspace,
  resolveWorkspaceDirectory,
  type WorkspaceSandbox,
} from "../../extension/lib/workspace-root.ts";

test("workspace directories default to the workspace and need no git checkout", async () => {
  const runs: string[] = [];
  const sandbox = workspaceSandbox("/app", {}, runs);
  assert.equal(await resolveWorkspaceDirectory(sandbox), "/app");
  assert.equal(await resolveWorkspaceDirectory(sandbox, "/app/src"), "/app/src");
  assert.equal(
    runs.some((command) => command.startsWith("git ")),
    false,
  );
});

test("workspace directories must be absolute and stay inside the workspace", async () => {
  await assert.rejects(
    resolveWorkspaceDirectory(workspaceSandbox("/app"), "/etc"),
    /root resolves outside the workspace \/app: \/etc/u,
  );
  await assert.rejects(resolveWorkspaceDirectory(workspaceSandbox("/app"), "src"), /absolute/u);
});

test("containment follows symlinks before comparing", async () => {
  await assert.rejects(
    resolveInWorkspace(workspaceSandbox("/app", { "/app/link": "/etc" }), "/app/link", "grep path"),
    /grep path resolves outside the workspace \/app: \/etc/u,
  );
});

test("real paths are read NUL-delimited, so newlines in names survive", async () => {
  const sandbox = workspaceSandbox("/app", { "/app/odd": "/app/line\nbreak" });
  assert.deepEqual(await resolveInWorkspace(sandbox, "/app/odd", "root"), {
    path: "/app/line\nbreak",
    workspace: "/app",
  });
});

test("a missing path reports the provider's error", async () => {
  const sandbox: WorkspaceSandbox = {
    resolvePath: () => "/app",
    async run({ command }) {
      return command.includes("'/app'")
        ? { exitCode: 0, stdout: "/app\0", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "realpath: /app/missing: No such file or directory" };
    },
  };
  await assert.rejects(
    resolveWorkspaceDirectory(sandbox, "/app/missing"),
    /root could not be resolved: realpath: \/app\/missing: No such file/u,
  );
});

test("repository roots add the git toplevel check", async () => {
  assert.equal(
    await validateRepositoryRoot(workspaceSandbox("/workspace"), "/workspace/repo"),
    "/workspace/repo",
  );
  await assert.rejects(
    validateRepositoryRoot(workspaceSandbox("/workspace", {}, [], "/workspace"), "/workspace/repo"),
    /not a git work tree root/u,
  );
  await assert.rejects(
    validateRepositoryRoot(workspaceSandbox("/workspace"), "/outside/repo"),
    /resolves outside the workspace/u,
  );
});

function workspaceSandbox(
  workspace: string,
  links: Readonly<Record<string, string>> = {},
  runs: string[] = [],
  gitTop?: string,
): WorkspaceSandbox {
  return {
    resolvePath: () => workspace,
    async run({ command }) {
      runs.push(command);
      const realpath = /^realpath -e -z -- '([^']*)'$/u.exec(command);
      if (realpath) {
        const path = realpath[1]!;
        return { exitCode: 0, stdout: `${links[path] ?? path}\0`, stderr: "" };
      }
      const git = /^git -C '([^']*)' rev-parse --show-toplevel$/u.exec(command);
      if (git) return { exitCode: 0, stdout: `${gitTop ?? git[1]}\n`, stderr: "" };
      throw new Error(`unexpected command: ${command}`);
    },
  };
}
