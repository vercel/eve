import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import { executeReadFileOnSandbox } from "../src/execution/sandbox/read-file-tool.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";
import type { WriteFileResult } from "../src/execution/sandbox/write-file-tool.js";
import { executeWriteFileOnSandbox } from "../src/execution/sandbox/write-file-tool.js";
import {
  createReadFileStamp,
  ReadFileStateKey,
} from "../src/runtime/framework-tools/file-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeAccess(files: Record<string, string>): {
  access: SandboxAccess;
  files: Record<string, string>;
  session: SandboxSession;
} {
  const session = {
    id: "test-write-file-sandbox",
    async readFile() {
      return null;
    },
    async readBinaryFile() {
      return null;
    },
    async readTextFile({ path }: { path: string }) {
      const content = files[path];
      return content ?? null;
    },
    async setNetworkPolicy() {},
    async removePath({ path }: { path: string }) {
      delete files[path];
    },
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
    async writeTextFile({ path, content }: { path: string; content: string }) {
      files[path] = content;
    },
  } as SandboxSession;

  return {
    access: {
      async captureState() {
        return { initialized: false, session: null };
      },
      async get() {
        return session;
      },
    },
    files,
    session,
  };
}

// ---------------------------------------------------------------------------
// Create new file
// ---------------------------------------------------------------------------

describe("executeWriteFileOnSandbox", () => {
  it("creates a new file without prior read", async () => {
    const { access, files, session } = createFakeAccess({});

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/new.ts",
        content: "hello",
      }),
    )) as WriteFileResult;

    expect(result.existed).toBe(false);
    expect(result.path).toBe("/workspace/new.ts");
    expect(files["/workspace/new.ts"]).toBe("hello");
  });

  // ---------------------------------------------------------------------------
  // Overwrite after read
  // ---------------------------------------------------------------------------

  it("overwrites an existing file after prior read", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
    });

    const stamp = createReadFileStamp({
      content: "original",
      filePath: "/workspace/foo.ts",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, {
      byTarget: { "/workspace/foo.ts": stamp },
    });

    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "updated",
      }),
    )) as WriteFileResult;

    expect(result.existed).toBe(true);
    expect(files["/workspace/foo.ts"]).toBe("updated");
  });

  it("overwrites an empty existing file after reading it", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/empty.ts": "",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    const result = (await contextStorage.run(ctx, async () => {
      await executeReadFileOnSandbox(session, {
        filePath: "/workspace/empty.ts",
      });

      return executeWriteFileOnSandbox(session, {
        filePath: "/workspace/empty.ts",
        content: "updated",
      });
    })) as WriteFileResult;

    expect(result.existed).toBe(true);
    expect(files["/workspace/empty.ts"]).toBe("updated");
  });

  // ---------------------------------------------------------------------------
  // Reject overwrite without prior read
  // ---------------------------------------------------------------------------

  it("rejects overwrite without prior read", async () => {
    const { access, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await expect(
      contextStorage.run(ctx, () =>
        executeWriteFileOnSandbox(session, {
          filePath: "/workspace/foo.ts",
          content: "new content",
        }),
      ),
    ).rejects.toThrow(
      "You must read file /workspace/foo.ts before overwriting it. Use the read_file tool first.",
    );
  });

  // ---------------------------------------------------------------------------
  // Reject overwrite after external modification
  // ---------------------------------------------------------------------------

  it("rejects overwrite after external modification", async () => {
    const { access, session } = createFakeAccess({
      "/workspace/foo.ts": "externally-modified",
    });

    // Stamp was taken when the file had different content
    const stamp = createReadFileStamp({
      content: "original",
      filePath: "/workspace/foo.ts",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, {
      byTarget: { "/workspace/foo.ts": stamp },
    });

    await expect(
      contextStorage.run(ctx, () =>
        executeWriteFileOnSandbox(session, {
          filePath: "/workspace/foo.ts",
          content: "new content",
        }),
      ),
    ).rejects.toThrow(
      "File /workspace/foo.ts has been modified since it was last read. Please read the file again before modifying it.",
    );
  });

  // ---------------------------------------------------------------------------
  // Refreshes stamp after write
  // ---------------------------------------------------------------------------

  it("refreshes stamp after successful write", async () => {
    const { access, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
    });

    const stamp = createReadFileStamp({
      content: "original",
      filePath: "/workspace/foo.ts",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, {
      byTarget: { "/workspace/foo.ts": stamp },
    });

    await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "updated",
      }),
    );

    const state = ctx.require(ReadFileStateKey);
    const newStamp = state.byTarget["/workspace/foo.ts"];
    expect(newStamp).toBeDefined();
    // The stamp should be for the new content, not the original
    expect(newStamp?.contentHash).not.toBe(stamp.contentHash);
  });

  // ---------------------------------------------------------------------------
  // Write-after-write (no additional read needed)
  // ---------------------------------------------------------------------------

  it("allows a second write after the first write without another read", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
    });

    const stamp = createReadFileStamp({
      content: "original",
      filePath: "/workspace/foo.ts",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, {
      byTarget: { "/workspace/foo.ts": stamp },
    });

    // First write
    await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "first update",
      }),
    );

    // Second write — should succeed because stamp was refreshed
    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "second update",
      }),
    )) as WriteFileResult;

    expect(result.existed).toBe(true);
    expect(files["/workspace/foo.ts"]).toBe("second update");
  });

  // ---------------------------------------------------------------------------
  // Path validation
  // ---------------------------------------------------------------------------

  it("rejects relative paths", async () => {
    const { access, session } = createFakeAccess({});

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await expect(
      contextStorage.run(ctx, () =>
        executeWriteFileOnSandbox(session, {
          filePath: "foo.ts",
          content: "hello",
        }),
      ),
    ).rejects.toThrow("filePath must be an absolute path");
  });

  // ---------------------------------------------------------------------------
  // Path canonicalization
  // ---------------------------------------------------------------------------

  it("absolute-path canonicalization shares stamp", async () => {
    // Both the read and write executors normalize the model-supplied
    // path via `normalizeModelPath` before building the target key,
    // so dot-segment variants collapse to the same canonical key.
    // Seed the fake file system with both variants so the sandbox
    // resolves the file regardless of which path the executor passes.
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
      "/workspace/./foo.ts": "original",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    // Read using a non-canonical path variant — the executor normalizes
    // internally so the stamp is keyed by the canonical path.
    await contextStorage.run(ctx, () =>
      executeReadFileOnSandbox(session, { filePath: "/workspace/./foo.ts" }),
    );

    // Write using the canonical path — should match the stamp stored
    // by the read above because both normalize to the same key.
    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "updated",
      }),
    )) as WriteFileResult;

    expect(result.existed).toBe(true);
    expect(files["/workspace/foo.ts"]).toBe("updated");
  });

  // ---------------------------------------------------------------------------
  // New file stores stamp
  // ---------------------------------------------------------------------------

  it("stores stamp after creating a new file", async () => {
    const { access, session } = createFakeAccess({});

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/new.ts",
        content: "hello",
      }),
    );

    const state = ctx.require(ReadFileStateKey);
    const stamp = state.byTarget["/workspace/new.ts"];
    expect(stamp).toBeDefined();
    expect(stamp?.filePath).toBe("/workspace/new.ts");
  });
});
