import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import { executeReadFileOnSandbox } from "../src/execution/sandbox/read-file.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";
import type { WriteFileResult } from "../src/execution/sandbox/write-file.js";
import { executeWriteFileOnSandbox } from "../src/execution/sandbox/write-file.js";
import { createReadFileStamp, ReadFileStateKey } from "../src/execution/tools/file-state.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

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
    async readBinaryFile({ path }: { path: string }) {
      const content = files[path];
      return content === undefined ? null : new TextEncoder().encode(content);
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
    async run({ command }: { command: string }) {
      if (command === HOME_PROBE_COMMAND) {
        return { exitCode: 0, stderr: "", stdout: "/home/agent\n" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async spawn() {
      return stubSpawnProcess();
    },
    async writeFile() {},
    async writeBinaryFile() {},
    async writeFiles() {},
    async writeTextFile({ path, content }: { path: string; content: string }) {
      files[path] = content;
    },
  } as SandboxSession;

  return {
    access: {
      async captureState() {
        return { initialized: false, session: null };
      },
      open() {
        return this.get();
      },
      prepare() {},
      async stop() {},
      async get() {
        return session;
      },
    },
    files,
    session,
  };
}

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

  it("overwrites an existing file without a prior read", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "new content",
      }),
    )) as WriteFileResult;

    expect(result).toEqual({ existed: true, path: "/workspace/foo.ts" });
    expect(files["/workspace/foo.ts"]).toBe("new content");
  });

  it("overwrites an existing file even after external modification", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "externally-modified",
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
        content: "new content",
      }),
    )) as WriteFileResult;

    expect(result).toEqual({ existed: true, path: "/workspace/foo.ts" });
    expect(files["/workspace/foo.ts"]).toBe("new content");
  });

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
    expect(newStamp?.contentHash).not.toBe(stamp.contentHash);
  });

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

    await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "first update",
      }),
    );

    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "second update",
      }),
    )) as WriteFileResult;

    expect(result.existed).toBe(true);
    expect(files["/workspace/foo.ts"]).toBe("second update");
  });

  it("shares read-before-write state with the resolved form of a $HOME path", async () => {
    const filePath = "/home/agent/.agents/skills/research/references/catalog.md";
    const { access, files, session } = createFakeAccess({ [filePath]: "original" });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    const result = (await contextStorage.run(ctx, async () => {
      await executeReadFileOnSandbox(session, { filePath });
      return await executeWriteFileOnSandbox(session, {
        content: "updated",
        filePath: "$HOME/.agents/skills/research/references/catalog.md",
      });
    })) as WriteFileResult;

    expect(result).toEqual({ existed: true, path: filePath });
    expect(files[filePath]).toBe("updated");
  });

  it("absolute-path canonicalization shares stamp", async () => {
    const { access, files, session } = createFakeAccess({
      "/workspace/foo.ts": "original",
      "/workspace/./foo.ts": "original",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, access);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await contextStorage.run(ctx, () =>
      executeReadFileOnSandbox(session, { filePath: "/workspace/./foo.ts" }),
    );

    const result = (await contextStorage.run(ctx, () =>
      executeWriteFileOnSandbox(session, {
        filePath: "/workspace/foo.ts",
        content: "updated",
      }),
    )) as WriteFileResult;

    expect(result.existed).toBe(true);
    expect(files["/workspace/foo.ts"]).toBe("updated");
  });

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
