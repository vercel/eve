import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import { executeReadFileOnSandbox } from "../src/execution/sandbox/read-file-tool.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";
import { executeWriteFileOnSandbox } from "../src/execution/sandbox/write-file-tool.js";
import { ReadFileStateKey } from "../src/runtime/framework-tools/file-state.js";
import { preserveFrameworkStateOnCompaction } from "../src/execution/compaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeAccess(files: Record<string, string>): {
  access: SandboxAccess;
  files: Record<string, string>;
  session: SandboxSession;
} {
  const session = {
    id: "test-file-compaction-sandbox",
    async readFile() {
      return null;
    },
    async readBinaryFile() {
      return null;
    },
    async readTextFile({ path }: { path: string }) {
      return files[path] ?? null;
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
// Compaction tests
// ---------------------------------------------------------------------------

describe("read_file compaction", () => {
  it("preserveFrameworkStateOnCompaction() clears read-file state", () => {
    const ctx = new ContextContainer();
    ctx.set(ReadFileStateKey, {
      byTarget: { "/workspace/foo.ts": {} as never },
    });

    contextStorage.run(ctx, () => preserveFrameworkStateOnCompaction());

    const state = ctx.require(ReadFileStateKey);
    expect(state.byTarget).toEqual({});
  });

  it("after compaction, a previously read file must be read again before overwrite", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    // Read the file first
    await contextStorage.run(ctx, () =>
      executeReadFileOnSandbox(session, { filePath: "/workspace/foo.ts" }),
    );

    // Verify stamp exists
    const stateBeforeCompaction = ctx.require(ReadFileStateKey);
    expect(stateBeforeCompaction.byTarget["/workspace/foo.ts"]).toBeDefined();

    // Simulate compaction — the framework resets read-before-write tracking.
    contextStorage.run(ctx, () => preserveFrameworkStateOnCompaction());

    // Verify stamp is gone
    const stateAfterCompaction = ctx.require(ReadFileStateKey);
    expect(stateAfterCompaction.byTarget["/workspace/foo.ts"]).toBeUndefined();

    // Write should now fail
    await expect(
      contextStorage.run(ctx, () =>
        executeWriteFileOnSandbox(session, {
          filePath: "/workspace/foo.ts",
          content: "updated",
        }),
      ),
    ).rejects.toThrow("You must read file /workspace/foo.ts before overwriting it.");

    // But writing still works after re-reading
    await contextStorage.run(ctx, () =>
      executeReadFileOnSandbox(session, { filePath: "/workspace/foo.ts" }),
    );

    await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "updated after re-read",
      }),
    );

    expect(files["/workspace/foo.ts"]).toBe("updated after re-read");
  });
});
