import { posix } from "node:path";

import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import { executeGlobOnSandbox, type GlobResult } from "../src/execution/sandbox/glob-tool.js";
import { toolModelOutputContext } from "../src/harness/tool-model-output.js";
import { glob } from "../src/tools/provided/glob.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createFakeAccess(
  commandHandler: (command: string) => { exitCode: number; stderr: string; stdout: string },
): SandboxAccess {
  return {
    async captureState() {
      return { initialized: false, session: null };
    },

    open() {
      return this.get();
    },
    prepare() {},
    async stop() {},

    async get() {
      return {
        id: `test-glob-sandbox-${crypto.randomUUID()}`,
        async readFile() {
          return null;
        },
        async readBinaryFile() {
          return null;
        },
        async readTextFile() {
          return null;
        },
        async setNetworkPolicy() {},
        async removePath() {},
        resolvePath(path: string) {
          return posix.resolve("/workspace", path);
        },
        async run({ command }: { command: string }) {
          if (command === HOME_PROBE_COMMAND) {
            return { exitCode: 0, stderr: "", stdout: "/home/agent\n" };
          }
          return commandHandler(command);
        },
        async spawn() {
          return stubSpawnProcess();
        },
        async writeFile() {},
        async writeBinaryFile() {},
        async writeFiles() {},
        async writeTextFile() {},
      };
    },
  };
}

async function runInContext(
  commandHandler: (command: string) => { exitCode: number; stderr: string; stdout: string },
  fn: (sandbox: SandboxSession) => Promise<unknown>,
): Promise<unknown> {
  const access = createFakeAccess(commandHandler);
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, access);
  const sandbox = await access.get();
  return contextStorage.run(ctx, () => fn(sandbox!));
}

describe("executeGlobOnSandbox", () => {
  it("searches the workspace root when path is omitted", async () => {
    let capturedCommand = "";
    const result = (await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "/workspace/foo.ts\n" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    )) as GlobResult;

    expect(capturedCommand).toContain("/workspace");
    expect(result.path).toBe("/workspace");
    expect(result.count).toBe(1);
    expect(result.content).toContain("/workspace/foo.ts");
  });

  it("passes explicit absolute path through", async () => {
    let capturedCommand = "";
    const result = (await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "/workspace/src/foo.ts\n" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "*.ts", path: "/workspace/src" }),
    )) as GlobResult;

    expect(capturedCommand).toContain("/workspace/src");
    expect(result.path).toBe("/workspace/src");
  });

  it("expands a leading $HOME before searching", async () => {
    let capturedCommand = "";
    const result = (await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/home/agent/.agents/skills/research/SKILL.md\n",
        };
      },
      (sandbox) =>
        executeGlobOnSandbox(sandbox, {
          path: "$HOME/.agents/skills/research",
          pattern: "**/*.md",
        }),
    )) as GlobResult;

    expect(capturedCommand).toContain("'/home/agent/.agents/skills/research'");
    expect(result.path).toBe("/home/agent/.agents/skills/research");
  });

  it("returns 'No files found' when rg returns empty output", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 1, stderr: "", stdout: "" }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.xyz" }),
    )) as GlobResult;

    expect(result.content).toBe("No files found");
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("parses multiple file paths from rg stdout", async () => {
    const stdout = "/workspace/a.ts\n/workspace/b.ts\n/workspace/c.ts\n";
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    )) as GlobResult;

    expect(result.count).toBe(3);
    expect(result.content).toContain("/workspace/a.ts");
    expect(result.content).toContain("/workspace/b.ts");
    expect(result.content).toContain("/workspace/c.ts");
    expect(result.truncated).toBe(false);
  });

  it("truncates when result count exceeds limit", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `/workspace/file${i}.ts`);
    const stdout = `${lines.join("\n")}\n`;

    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts", limit: 5 }),
    )) as GlobResult;

    expect(result.count).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("Results truncated");
    expect(result.content).not.toContain("/workspace/file5.ts");
  });

  it("default limit is 100", async () => {
    const lines = Array.from({ length: 101 }, (_, i) => `/workspace/file${i}.ts`);
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout: `${lines.join("\n")}\n` }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    )) as GlobResult;

    expect(result.count).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("respects explicit limit", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `/workspace/file${i}.ts`);
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout: `${lines.join("\n")}\n` }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts", limit: 50 }),
    )) as GlobResult;

    expect(result.count).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it("hard-caps limit at 1000", async () => {
    const lines = Array.from({ length: 1100 }, (_, i) => `/workspace/file${i}.ts`);
    const result = (await runInContext(
      () => ({
        exitCode: 0,
        stderr: "",
        stdout: `${lines.join("\n")}\n`,
      }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts", limit: 5000 }),
    )) as GlobResult;

    expect(result.count).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it("does not pipe to `head` (which would mask rg's exit code) and runs in a single sandbox call", async () => {
    const commands: string[] = [];
    await runInContext(
      (cmd) => {
        commands.push(cmd);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("head");
    expect(commands[0]).not.toMatch(/(?<!\|)\|(?!\|)/);
  });

  it("shell-quotes patterns with special characters", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.{ts,tsx}" }),
    );

    expect(capturedCommand).toContain("'**/*.{ts,tsx}'");
  });

  it("shell-quotes paths with spaces", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) =>
        executeGlobOnSandbox(sandbox, { pattern: "*.ts", path: "/workspace/my project" }),
    );

    expect(capturedCommand).toContain("'/workspace/my project'");
  });

  it("normalizes paths with dot segments", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout: "/workspace/src/foo.ts\n" }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "*.ts", path: "/workspace/./src" }),
    )) as GlobResult;

    expect(result.path).toBe("/workspace/src");
  });

  it("passes the logical /workspace path directly into the rg and find branches", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    );

    expect(capturedCommand).toContain(
      "rg --files --hidden --glob '!.git/*' --glob '**/*.ts' '/workspace'",
    );
    expect(capturedCommand).toContain(
      "find '/workspace' -type f -not -path '*/.git/*' -name '*.ts'",
    );
  });

  it("preserves /workspace-rooted output paths exactly as emitted", async () => {
    const result = (await runInContext(
      () => ({
        exitCode: 0,
        stderr: "",
        stdout: ["/workspace/src/a.ts", "/workspace/src/b.ts", ""].join("\n"),
      }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    )) as GlobResult;

    expect(result.count).toBe(2);
    expect(result.content).toContain("/workspace/src/a.ts");
    expect(result.content).toContain("/workspace/src/b.ts");
  });

  it.each([
    { name: "incompatible rg", commands: undefined },
    { name: "missing rg", commands: ["find"] as "find"[] },
  ])("falls back to POSIX find in one shell call when $name", async ({ commands }) => {
    const shell = new Bash({
      commands,
      files: {
        "/workspace/.git/config": "ignored\n",
        "/workspace/src/a.ts": "export const a = 1;\n",
        "/workspace/src/b.js": "export const b = 2;\n",
      },
    });
    const runCalls: string[] = [];
    const base = await createFakeAccess(() => ({ exitCode: 0, stderr: "", stdout: "" })).get();
    if (base === null) throw new Error("expected sandbox");
    const sandbox: SandboxSession = {
      ...base,
      async run({ command }) {
        runCalls.push(command);
        const result = await shell.exec(command);
        return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
      },
    };

    const result = await executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" });

    expect(runCalls).toHaveLength(1);
    expect(result).toEqual({
      content: "/workspace/src/a.ts",
      count: 1,
      path: "/workspace",
      truncated: false,
    });
  });

  it("throws when ripgrep reports a runtime error (exit 2)", async () => {
    await expect(
      runInContext(
        () => ({
          exitCode: 2,
          stderr: "rg: IO error\n",
          stdout: "",
        }),
        (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
      ),
    ).rejects.toThrow(/glob failed \(exit 2\).*IO error/s);
  });

  it("throws when ripgrep exits 1 with an error message", async () => {
    await expect(
      runInContext(
        () => ({ exitCode: 1, stderr: "rg: unrecognized option '--'\n", stdout: "" }),
        (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
      ),
    ).rejects.toThrow(/glob failed \(exit 1\).*unrecognized option/s);
  });

  it("treats exit 1 as legitimate 'no files'", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 1, stderr: "", stdout: "" }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.xyz" }),
    )) as GlobResult;

    expect(result.content).toBe("No files found");
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe("glob.toModelOutput", () => {
  it("renders standard results as plain text and preserves wrapper extra fields as JSON", async () => {
    expect(
      await glob.toModelOutput?.(
        { content: "/workspace/a.ts", count: 1, path: "/workspace", truncated: false },
        toolModelOutputContext("glob", "call_1"),
      ),
    ).toEqual({ type: "text", value: "/workspace/a.ts" });

    const wrapped = {
      content: "/workspace/a.ts",
      count: 1,
      extra: "keep",
      path: "/workspace",
      truncated: false,
    };
    expect(
      await glob.toModelOutput?.(wrapped as never, toolModelOutputContext("glob", "call_2")),
    ).toEqual({ type: "json", value: wrapped });
  });
});
