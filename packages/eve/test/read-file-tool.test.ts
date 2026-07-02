import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import type { ReadFileResult } from "../src/execution/sandbox/read-file-tool.js";
import { executeReadFileOnSandbox } from "../src/execution/sandbox/read-file-tool.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";
import { ReadFileStateKey } from "../src/runtime/framework-tools/file-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeAccess(files: Record<string, string | null>): SandboxAccess {
  return {
    async captureState() {
      return { initialized: false, session: null };
    },

    async get() {
      return {
        id: "test-read-file-sandbox",
        async readFile() {
          return null;
        },
        async readBinaryFile() {
          return null;
        },
        async readTextFile({ path }: { path: string }) {
          const content = files[path];
          if (content === undefined) return null;
          return content;
        },
        async setNetworkPolicy() {},
        async removePath() {},
        resolvePath(path: string) {
          return path;
        },
        async run(_options: { command: string }) {
          return { exitCode: 0, stderr: "", stdout: "" };
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
  files: Record<string, string | null>,
  fn: (sandbox: SandboxSession) => Promise<unknown>,
): Promise<unknown> {
  const access = createFakeAccess(files);
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, access);
  ctx.set(ReadFileStateKey, { byTarget: {} });
  const sandbox = await access.get();
  return contextStorage.run(ctx, () => fn(sandbox!));
}

// ---------------------------------------------------------------------------
// Basic read
// ---------------------------------------------------------------------------

describe("executeReadFileOnSandbox", () => {
  it("reads a small text file successfully", async () => {
    const result = (await runInContext({ "/workspace/foo.ts": "hello\nworld\n" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts" }),
    )) as ReadFileResult;

    expect(result.totalLines).toBe(2);
    expect(result.content).toContain("1: hello");
    expect(result.content).toContain("2: world");
    expect(result.path).toBe("/workspace/foo.ts");
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty("nextOffset");
  });

  // ---------------------------------------------------------------------------
  // Offset and limit
  // ---------------------------------------------------------------------------

  it("default offset = 1", async () => {
    const result = (await runInContext({ "/workspace/foo.ts": "a\nb\nc\n" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts" }),
    )) as ReadFileResult;

    expect(result.content).toMatch(/^1: a/);
  });

  it("explicit offset", async () => {
    const result = (await runInContext({ "/workspace/foo.ts": "a\nb\nc\n" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts", offset: 2 }),
    )) as ReadFileResult;

    expect(result.content).toMatch(/^2: b/);
    expect(result.content).not.toContain("1: a");
  });

  it("explicit limit", async () => {
    const result = (await runInContext({ "/workspace/foo.ts": "a\nb\nc\nd\n" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, {
        filePath: "/workspace/foo.ts",
        limit: 2,
      }),
    )) as ReadFileResult;

    expect(result.content).toContain("1: a");
    expect(result.content).toContain("2: b");
    expect(result.content).not.toContain("3: c");
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  it("offset < 1 errors", async () => {
    await expect(
      runInContext({ "/workspace/foo.ts": "a\n" }, (sandbox) =>
        executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts", offset: 0 }),
      ),
    ).rejects.toThrow("offset must be >= 1");
  });

  it("offset past EOF errors", async () => {
    await expect(
      runInContext({ "/workspace/foo.ts": "a\nb\n" }, (sandbox) =>
        executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts", offset: 5 }),
      ),
    ).rejects.toThrow("offset 5 is past the end of the file (2 lines)");
  });

  // ---------------------------------------------------------------------------
  // Empty file
  // ---------------------------------------------------------------------------

  it("empty file at default offset succeeds", async () => {
    const result = (await runInContext({ "/workspace/empty.ts": "" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/empty.ts" }),
    )) as ReadFileResult;

    expect(result.totalLines).toBe(0);
    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("empty file with offset > 1 errors", async () => {
    const access = createFakeAccess({ "/workspace/empty.ts": "" });
    const sandbox = (await access.get())!;

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await expect(
      contextStorage.run(ctx, () =>
        executeReadFileOnSandbox(sandbox, { filePath: "/workspace/empty.ts", offset: 2 }),
      ),
    ).rejects.toThrow("offset 2 is past the end of the file (0 lines)");

    expect(ctx.require(ReadFileStateKey).byTarget).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Line numbering and truncation
  // ---------------------------------------------------------------------------

  it("lines are numbered correctly", async () => {
    const result = (await runInContext({ "/workspace/foo.ts": "alpha\nbeta\ngamma\n" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts" }),
    )) as ReadFileResult;

    const lines = result.content.split("\n");
    expect(lines[0]).toBe("1: alpha");
    expect(lines[1]).toBe("2: beta");
    expect(lines[2]).toBe("3: gamma");
  });

  it("long lines truncate at 2000 characters", async () => {
    const longLine = "x".repeat(3000);
    const result = (await runInContext({ "/workspace/long.ts": `${longLine}\n` }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/long.ts" }),
    )) as ReadFileResult;

    const outputLine = result.content.split("\n")[0] ?? "";
    expect(outputLine).toContain("[truncated]");
    // Line prefix "1: " (3 chars) + 2000 chars + " [truncated]" = expected
    expect(outputLine.length).toBeLessThan(3000);
  });

  it("output caps at 50 KiB", async () => {
    // Create a file with many lines that exceed 50 KiB total
    const lines = Array.from({ length: 5000 }, (_, i) => `Line ${i + 1} ${"x".repeat(20)}`);
    const content = `${lines.join("\n")}\n`;

    const result = (await runInContext({ "/workspace/big.ts": content }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/big.ts" }),
    )) as ReadFileResult;

    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBeDefined();
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(52 * 1024);
  });

  it("nextOffset is returned when truncated by limit", async () => {
    const result = (await runInContext({ "/workspace/foo.ts": "a\nb\nc\nd\ne\n" }, (sandbox) =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts", limit: 2 }),
    )) as ReadFileResult;

    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Path validation
  // ---------------------------------------------------------------------------

  it("rejects relative paths", async () => {
    await expect(
      runInContext({ "/workspace/foo.ts": "content" }, (sandbox) =>
        executeReadFileOnSandbox(sandbox, { filePath: "foo.ts" }),
      ),
    ).rejects.toThrow("filePath must be an absolute path");
  });

  // ---------------------------------------------------------------------------
  // Missing file
  // ---------------------------------------------------------------------------

  it("missing file errors clearly", async () => {
    await expect(
      runInContext({}, (sandbox) =>
        executeReadFileOnSandbox(sandbox, { filePath: "/workspace/missing.ts" }),
      ),
    ).rejects.toThrow("File not found: /workspace/missing.ts");
  });

  // ---------------------------------------------------------------------------
  // Binary file
  // ---------------------------------------------------------------------------

  it("NUL-containing file is rejected", async () => {
    await expect(
      runInContext({ "/workspace/binary.bin": "hello\0world" }, (sandbox) =>
        executeReadFileOnSandbox(sandbox, { filePath: "/workspace/binary.bin" }),
      ),
    ).rejects.toThrow("contains NUL bytes");
  });

  // ---------------------------------------------------------------------------
  // Durable stamp
  // ---------------------------------------------------------------------------

  it("successful read writes a durable stamp", async () => {
    const access = createFakeAccess({ "/workspace/foo.ts": "hello\n" });
    const sandbox = (await access.get())!;

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await contextStorage.run(ctx, () =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/foo.ts" }),
    );

    const state = ctx.require(ReadFileStateKey);
    const stamp = state.byTarget["/workspace/foo.ts"];
    expect(stamp).toBeDefined();
    expect(stamp?.filePath).toBe("/workspace/foo.ts");
    expect(stamp?.contentHash).toBeTruthy();
    expect(stamp?.byteLength).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Path canonicalization
  // ---------------------------------------------------------------------------

  it("canonicalizes paths with dot segments", async () => {
    const access = createFakeAccess({ "/workspace/./foo.ts": "hello\n" });
    const sandbox = (await access.get())!;

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await contextStorage.run(ctx, () =>
      executeReadFileOnSandbox(sandbox, { filePath: "/workspace/./foo.ts" }),
    );

    const state = ctx.require(ReadFileStateKey);
    // The stamp should be under the normalized path
    expect(state.byTarget["/workspace/foo.ts"]).toBeDefined();
  });
});
