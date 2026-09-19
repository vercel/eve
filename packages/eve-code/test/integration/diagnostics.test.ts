import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxSession } from "eve/sandbox";

import {
  runPostEditDiagnostics,
  runTypeScriptDiagnostics,
} from "../../extension/lib/diagnostics.ts";

test("reports git and supported-file syntax diagnostics", async () => {
  const commands: string[] = [];
  const sandbox = commandSandbox(async ({ command }) => {
    commands.push(command);
    if (command.includes("diff --check")) {
      return { exitCode: 2, stdout: "", stderr: "src/file.ts: trailing whitespace" };
    }
    if (command.includes("--experimental-strip-types")) {
      return { exitCode: 1, stdout: "", stderr: "SyntaxError: Unexpected token" };
    }
    if (command.includes("diagnostics.cjs")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          diagnostics: [
            { code: 2322, column: 7, line: 1, message: "Type string is not assignable" },
          ],
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });

  const diagnostics = await runPostEditDiagnostics({
    changedPaths: ["src/file.ts", "README.md"],
    deletedPaths: ["old.ts"],
    repoRoot: "/workspace/eve",
    sandbox,
  });

  assert.deepEqual(diagnostics, [
    { check: "git-diff", message: "src/file.ts: trailing whitespace" },
    { check: "syntax", path: "src/file.ts", message: "SyntaxError: Unexpected token" },
    {
      check: "typescript",
      code: 2322,
      column: 7,
      line: 1,
      message: "Type string is not assignable",
      path: "src/file.ts",
    },
  ]);
  assert.equal(commands.filter((command) => command.includes("README.md")).length, 1);
});

test("skips TypeScript diagnostics when the worker is not installed", async () => {
  const sandbox = commandSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "" }), null);
  assert.deepEqual(
    await runTypeScriptDiagnostics({
      paths: ["src/file.ts"],
      repoRoot: "/workspace/eve",
      sandbox,
    }),
    [],
  );
});

test("reports diagnostic runner failures without failing a committed edit", async () => {
  const sandbox = commandSandbox(async () => {
    throw new Error("sandbox unavailable");
  });
  const diagnostics = await runPostEditDiagnostics({
    changedPaths: ["src/file.js"],
    deletedPaths: [],
    repoRoot: "/workspace/eve",
    sandbox,
  });
  assert.deepEqual(diagnostics, [
    { check: "git-diff", message: "Could not run git diff --check: sandbox unavailable" },
    {
      check: "syntax",
      path: "src/file.js",
      message: "Could not run syntax check: sandbox unavailable",
    },
  ]);
});

function commandSandbox(
  run: SandboxSession["run"],
  worker: string | null = "worker",
): SandboxSession {
  return {
    id: `sandbox-${crypto.randomUUID()}`,
    run,
    resolvePath(path) {
      return `/workspace/${path}`;
    },
    async readTextFile({ path }) {
      return path.endsWith("diagnostics.cjs") ? worker : null;
    },
    async setNetworkPolicy() {},
    async removePath() {},
    async spawn() {
      throw new Error("not used by this test");
    },
    async readFile() {
      throw new Error("not used by this test");
    },
    async readBinaryFile() {
      throw new Error("not used by this test");
    },
    async writeFile() {
      throw new Error("not used by this test");
    },
    async writeBinaryFile() {
      throw new Error("not used by this test");
    },
    async writeTextFile() {
      throw new Error("not used by this test");
    },
  };
}
