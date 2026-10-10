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
    if (command.includes("rev-parse --is-inside-work-tree")) {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
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
    patchRoot: "/workspace/eve",
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

for (const [name, probe] of [
  ["outside a git checkout", { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }],
  ["inside a .git directory or bare repository", { exitCode: 0, stdout: "false\n", stderr: "" }],
] as const) {
  test(`checks whitespace in updated files ${name}`, async () => {
    const commands: string[] = [];
    const sandbox = commandSandbox(
      async ({ command }) => {
        commands.push(command);
        return command.includes("rev-parse") ? probe : { exitCode: 0, stdout: "", stderr: "" };
      },
      "worker",
      { "/app/README.md": "# Title \nkept  \nnew line \n" },
    );

    const diagnostics = await runPostEditDiagnostics({
      changedPaths: ["README.md"],
      deletedPaths: [],
      patchRoot: "/app",
      previousContents: new Map([["README.md", "# Title\nkept  \n"]]),
      sandbox,
    });

    assert.deepEqual(diagnostics, [
      {
        check: "whitespace",
        path: "README.md",
        message: "line 1: trailing whitespace\nline 3: trailing whitespace",
      },
    ]);
    assert.equal(
      commands.some((command) => command.includes("diff --check")),
      false,
    );
  });
}

test("skips TypeScript diagnostics when the worker is not installed", async () => {
  const sandbox = commandSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "" }), null);
  assert.deepEqual(
    await runTypeScriptDiagnostics({
      paths: ["src/file.ts"],
      patchRoot: "/workspace/eve",
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
    patchRoot: "/workspace/eve",
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
  files: Readonly<Record<string, string>> = {},
): SandboxSession {
  return {
    run,
    resolvePath(path) {
      return `/workspace/${path}`;
    },
    async readTextFile({ path }) {
      return path.endsWith("diagnostics.cjs") ? worker : (files[path] ?? null);
    },
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
