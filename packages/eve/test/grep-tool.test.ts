import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import { executeGrepOnSandbox, type GrepResult } from "../src/execution/sandbox/grep-tool.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeAccessOptions {
  readonly pathResolver?: (path: string) => string;
  /**
   * Exit code returned by the `command -v rg` probe that runs before
   * each grep call. Defaults to `0` (ripgrep is available) so the
   * tests exercise the ripgrep code path by default. Set to a
   * non-zero code to force the POSIX fallback branch.
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
        id: `test-grep-sandbox-${crypto.randomUUID()}`,
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

describe("executeGrepOnSandbox", () => {
  // ---------------------------------------------------------------------------
  // Default behavior
  // ---------------------------------------------------------------------------

  it("uses /workspace as default path when path omitted", async () => {
    let capturedCommand = "";
    const result = (await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/workspace/foo.ts:10:const x = 1;\n",
        };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "const x" }),
    )) as GrepResult;

    expect(capturedCommand).toContain("/workspace");
    expect(result.path).toBe("/workspace");
    expect(result.matchCount).toBe(1);
  });

  it("passes explicit absolute path through", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 0, stderr: "", stdout: "/workspace/src/foo.ts:1:match\n" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "match", path: "/workspace/src" }),
    );

    expect(capturedCommand).toContain("/workspace/src");
  });

  // ---------------------------------------------------------------------------
  // Path validation
  // ---------------------------------------------------------------------------

  it("rejects relative paths", async () => {
    await expect(
      runInContext(
        () => ({ exitCode: 0, stderr: "", stdout: "" }),
        (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", path: "src" }),
      ),
    ).rejects.toThrow("filePath must be an absolute path");
  });

  // ---------------------------------------------------------------------------
  // Empty results
  // ---------------------------------------------------------------------------

  it("returns 'No matches found' for empty output", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 1, stderr: "", stdout: "" }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "nonexistent" }),
    )) as GrepResult;

    expect(result.content).toBe("No matches found");
    expect(result.matchCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Output parsing
  // ---------------------------------------------------------------------------

  it("parses match lines correctly and counts matches", async () => {
    const stdout = [
      "/workspace/foo.ts:10:const x = 1;",
      "/workspace/foo.ts:20:const y = 2;",
      "/workspace/bar.ts:5:const z = 3;",
      "",
    ].join("\n");

    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "const" }),
    )) as GrepResult;

    expect(result.matchCount).toBe(3);
    expect(result.content).toContain("/workspace/foo.ts:10:const x = 1;");
    expect(result.content).toContain("/workspace/bar.ts:5:const z = 3;");
    expect(result.truncated).toBe(false);
  });

  it("preserves interior blank lines while dropping the trailing split line", async () => {
    const stdout = [
      "/workspace/foo.ts:10:const x = 1;",
      "",
      "/workspace/foo.ts:12:const y = 2;",
      "",
    ].join("\n");

    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "const", context: 1 }),
    )) as GrepResult;

    expect(result.matchCount).toBe(2);
    expect(result.content).toBe(
      "/workspace/foo.ts:10:const x = 1;\n\n/workspace/foo.ts:12:const y = 2;",
    );
  });

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------

  it("adds --ignore-case flag when ignoreCase is true", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", ignoreCase: true }),
    );

    expect(capturedCommand).toContain("--ignore-case");
  });

  it("adds --fixed-strings flag when literal is true", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo.bar", literal: true }),
    );

    expect(capturedCommand).toContain("--fixed-strings");
  });

  it("adds --glob filter when glob is provided", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", glob: "*.ts" }),
    );

    expect(capturedCommand).toContain("--glob '*.ts'");
  });

  it("adds --context flag when context > 0", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", context: 3 }),
    );

    expect(capturedCommand).toContain("--context 3");
  });

  it("does not add --context flag when context is 0", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", context: 0 }),
    );

    expect(capturedCommand).not.toContain("--context");
  });

  // ---------------------------------------------------------------------------
  // Long line truncation
  // ---------------------------------------------------------------------------

  it("truncates lines longer than 2000 characters", async () => {
    const longLine = `/workspace/foo.ts:1:${"x".repeat(3000)}`;
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout: `${longLine}\n` }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "x" }),
    )) as GrepResult;

    expect(result.content).toContain("[truncated]");
    // The line should be truncated to 2000 chars + suffix
    const firstLine = result.content.split("\n")[0] ?? "";
    expect(firstLine.length).toBeLessThan(3000);
  });

  // ---------------------------------------------------------------------------
  // Output byte cap
  // ---------------------------------------------------------------------------

  it("caps output at 50 KiB", async () => {
    // Generate many match lines that exceed 50 KiB
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `/workspace/file.ts:${i + 1}:${"match content ".repeat(5)}`,
    );
    const stdout = `${lines.join("\n")}\n`;

    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "match", limit: 1000 }),
    )) as GrepResult;

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(55 * 1024); // some slack for truncation note
  });

  // ---------------------------------------------------------------------------
  // Limit
  // ---------------------------------------------------------------------------

  it("default limit is 100", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo" }),
    );

    expect(capturedCommand).toContain("--max-count 100");
  });

  it("respects explicit limit", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", limit: 50 }),
    );

    expect(capturedCommand).toContain("--max-count 50");
  });

  it("hard-caps limit at 1000", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", limit: 5000 }),
    );

    expect(capturedCommand).toContain("--max-count 1000");
  });

  // ---------------------------------------------------------------------------
  // Shell quoting
  // ---------------------------------------------------------------------------

  it("shell-quotes patterns with regex special characters", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "log.*Error" }),
    );

    expect(capturedCommand).toContain("'log.*Error'");
  });

  it("shell-quotes glob filters", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo", glob: "*.{ts,tsx}" }),
    );

    expect(capturedCommand).toContain("'*.{ts,tsx}'");
  });

  // ---------------------------------------------------------------------------
  // Path normalization
  // ---------------------------------------------------------------------------

  it("normalizes paths with dot segments", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout: "/workspace/src/foo.ts:1:match\n" }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "match", path: "/workspace/./src" }),
    )) as GrepResult;

    expect(result.path).toBe("/workspace/src");
  });

  // ---------------------------------------------------------------------------
  // Truncation notice
  // ---------------------------------------------------------------------------

  it("appends truncation notice when match limit reached", async () => {
    // Generate exactly limit number of match lines
    const lines = Array.from({ length: 5 }, (_, i) => `/workspace/file.ts:${i + 1}:match`);
    const stdout = `${lines.join("\n")}\n`;

    const result = (await runInContext(
      () => ({ exitCode: 0, stderr: "", stdout }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "match", limit: 5 }),
    )) as GrepResult;

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("Match limit reached");
  });

  // ---------------------------------------------------------------------------
  // Workspace path invariant
  // ---------------------------------------------------------------------------

  it("passes the logical /workspace path directly into the rg command", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo" }),
    );

    expect(capturedCommand).toMatch(/'\/workspace'$/);
  });

  it("preserves /workspace-rooted output paths exactly as emitted", async () => {
    const result = (await runInContext(
      () => ({
        exitCode: 0,
        stderr: "",
        stdout: [
          "/workspace/src/foo.ts:10:const x = 1;",
          "/workspace/src/bar.ts:5:const y = 2;",
          "",
        ].join("\n"),
      }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "const" }),
    )) as GrepResult;

    expect(result.matchCount).toBe(2);
    expect(result.content).toContain("/workspace/src/foo.ts:10:const x = 1;");
    expect(result.content).toContain("/workspace/src/bar.ts:5:const y = 2;");
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------
  //
  // Regression guard: the grep tool must surface sandbox-level failures
  // (missing `rg`, IO errors, regex errors) as thrown errors. Silently
  // returning "No matches found" on failure is indistinguishable from a
  // legitimate empty result and hides bugs like ripgrep not being
  // installed in a Vercel sandbox.

  it("falls back to POSIX grep when the probe reports `rg` is not installed", async () => {
    // Tracks the non-probe command issued after the fallback decision.
    let capturedCommand = "";
    const result = (await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return {
          exitCode: 0,
          stderr: "",
          stdout: "/workspace/foo.ts:10:match\n",
        };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo" }),
      { probeExitCode: 1 },
    )) as GrepResult;

    // POSIX grep with -r -n, not ripgrep.
    expect(capturedCommand.startsWith("grep -r -n")).toBe(true);
    expect(capturedCommand).not.toMatch(/^rg\b/);
    // Output is parsed the same way regardless of branch.
    expect(result.matchCount).toBe(1);
  });

  it("throws when the underlying grep command fails (exit 2)", async () => {
    await expect(
      runInContext(
        () => ({
          exitCode: 2,
          stderr: "grep: IO error\n",
          stdout: "",
        }),
        (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo" }),
        { probeExitCode: 1 },
      ),
    ).rejects.toThrow(/grep failed \(exit 2\).*IO error/s);
  });

  it("throws when ripgrep reports a runtime error (exit 2)", async () => {
    await expect(
      runInContext(
        () => ({
          exitCode: 2,
          stderr: "rg: regex parse error\n",
          stdout: "",
        }),
        (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "[[[" }),
      ),
    ).rejects.toThrow(/grep failed \(exit 2\).*regex parse error/s);
  });

  it("does not pass --no-messages (so rg errors surface on stderr)", async () => {
    let capturedCommand = "";
    await runInContext(
      (cmd) => {
        capturedCommand = cmd;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "foo" }),
    );

    expect(capturedCommand).not.toContain("--no-messages");
  });

  it("treats exit 1 as legitimate 'no matches'", async () => {
    const result = (await runInContext(
      () => ({ exitCode: 1, stderr: "", stdout: "" }),
      (sandbox) => executeGrepOnSandbox(sandbox, { pattern: "nonexistent" }),
    )) as GrepResult;

    expect(result.content).toBe("No matches found");
    expect(result.matchCount).toBe(0);
  });
});
