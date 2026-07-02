import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import { executeGlobOnSandbox, type GlobResult } from "../src/execution/sandbox/glob-tool.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeAccessOptions {
  readonly pathResolver?: (path: string) => string;
  /**
   * Exit code returned by the `command -v rg` probe that runs before
   * each glob call. Defaults to `0` (ripgrep is available) so tests
   * exercise the ripgrep code path by default. Set to a non-zero
   * code to force the POSIX fallback branch.
   */
  readonly probeExitCode?: number;
}

const PROBE_COMMAND = "command -v rg >/dev/null 2>&1";

function createFakeAccess(
  commandHandler: (command: string) => { exitCode: number; stderr: string; stdout: string },
  options: FakeAccessOptions = {},
): SandboxAccess {
  const probeExitCode = options.probeExitCode ?? 0;
  return {
    async captureState() {
      return { initialized: false, session: null };
    },

    async get() {
      return {
        // Use a fresh id per fake session so the ripgrep-probe cache
        // (keyed by `session.id`) does not leak across tests.
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
          return options.pathResolver ? options.pathResolver(path) : path;
        },
        async run({ command }: { command: string }) {
          if (command === PROBE_COMMAND) {
            return { exitCode: probeExitCode, stderr: "", stdout: "" };
          }
          return commandHandler(command);
        },
        async spawn() {
          return stubSpawnProcess();
        },
        async writeFile() {},
        async writeBinaryFile() {},
        async writeTextFile() {},
      };
    },
  };
}

async function runInContext(
  commandHandler: (command: string) => { exitCode: number; stderr: string; stdout: string },
  fn: (sandbox: SandboxSession) => Promise<unknown>,
  options: FakeAccessOptions = {},
): Promise<unknown> {
  const access = createFakeAccess(commandHandler, options);
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, access);
  const sandbox = await access.get();
  return contextStorage.run(ctx, () => fn(sandbox!));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeGlobOnSandbox", () => {
  // ---------------------------------------------------------------------------
  // Default behavior
  // ---------------------------------------------------------------------------

  it("uses /workspace as default path when path omitted", async () => {
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

  // ---------------------------------------------------------------------------
  // Path validation
  // ---------------------------------------------------------------------------

  it("rejects relative paths", async () => {
    await expect(
      runInContext(
        () => ({ exitCode: 0, stderr: "", stdout: "" }),
        (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "*.ts", path: "src" }),
      ),
    ).rejects.toThrow("filePath must be an absolute path");
  });

  // ---------------------------------------------------------------------------
  // Empty results
  // ---------------------------------------------------------------------------

  it("returns 'No files found' when rg returns empty output", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 1, stderr: "", stdout: "" }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.xyz" }),
    )) as GlobResult;

    expect(result.content).toBe("No files found");
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Limit and truncation
  // ---------------------------------------------------------------------------

  it("truncates when result count exceeds limit", async () => {
    // Generate limit+1 lines to trigger truncation
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
    // Truncation is now enforced in JS rather than via a shell pipe, so
    // the command itself carries no limit argument. Verify via behavior:
    // emitting 101 results triggers truncation.
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

    // Short filenames stay well under the 50 KiB byte cap so the
    // 1000-file hard cap takes effect.
    expect(result.count).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it("does not pipe to `head` (which would mask rg's exit code)", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    );

    expect(capturedCommand).not.toContain("head");
    expect(capturedCommand).not.toContain("|");
  });

  // ---------------------------------------------------------------------------
  // Shell quoting
  // ---------------------------------------------------------------------------

  it("shell-quotes patterns with special characters", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.{ts,tsx}" }),
    );

    // The pattern should be wrapped in single quotes
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

  // ---------------------------------------------------------------------------
  // Path normalization
  // ---------------------------------------------------------------------------

  it("normalizes paths with dot segments", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout: "/workspace/src/foo.ts\n" }),
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "*.ts", path: "/workspace/./src" }),
    )) as GlobResult;

    expect(result.path).toBe("/workspace/src");
  });

  // ---------------------------------------------------------------------------
  // Workspace path invariant
  // ---------------------------------------------------------------------------

  it("passes the logical /workspace path directly into the rg command", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
    );

    expect(capturedCommand).toMatch(/-- '\/workspace'/);
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

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------
  //
  // Regression guard: the glob tool must surface sandbox-level failures
  // (missing `rg`, IO errors) as thrown errors. Silently returning
  // "No files found" on failure hides bugs like ripgrep not being
  // installed in a Vercel sandbox.

  it("falls back to POSIX find when the probe reports `rg` is not installed", async () => {
    let capturedCommand = "";
    const result = (await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/workspace/foo.ts\n",
        };
      },
      (sandbox) => executeGlobOnSandbox(sandbox, { pattern: "**/*.ts" }),
      { probeExitCode: 1 },
    )) as GlobResult;

    // POSIX find, not ripgrep.
    expect(capturedCommand.startsWith("find ")).toBe(true);
    expect(capturedCommand).not.toMatch(/^rg\b/);
    expect(result.count).toBe(1);
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
