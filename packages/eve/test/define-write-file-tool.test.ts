import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import { defineWriteFileTool } from "../src/public/tools/define-write-file-tool.js";
import { serializeInputSchema } from "../src/shared/tool-schema.js";
import {
  createReadFileStamp,
  ReadFileStateKey,
} from "../src/runtime/framework-tools/file-state.js";

function createFakeAccess(files: Record<string, string>): SandboxAccess {
  return {
    async captureState() {
      return { initialized: false, session: null };
    },

    async get() {
      return {
        id: "test-write-file-sandbox",
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
        async writeTextFile({ path, content }: { path: string; content: string }) {
          files[path] = content;
        },
      };
    },
  };
}

describe("defineWriteFileTool", () => {
  it("produces a schema that never exposes a sandbox property to the model", () => {
    const tool = defineWriteFileTool();

    expect(tool).not.toHaveProperty("name");
    expect(tool.description).toBe("Write a file to the workspace sandbox.");
    expect(typeof tool.execute).toBe("function");

    const schema = serializeInputSchema(tool.inputSchema);
    expect(schema).toMatchObject({
      properties: {
        content: { type: "string" },
        filePath: { type: "string" },
      },
      type: "object",
    });
    expect(new Set(schema.required as string[])).toEqual(new Set(["filePath", "content"]));
    expect((schema.properties as Record<string, unknown>).sandbox).toBeUndefined();
  });

  it("uses an authored description when provided", () => {
    const tool = defineWriteFileTool({
      description: "Write files to the repo.",
    });

    expect(tool.description).toBe("Write files to the repo.");
  });

  it("writes new files through the agent's sandbox", async () => {
    const files: Record<string, string> = {};
    const fakeAccess = createFakeAccess(files);

    const tool = defineWriteFileTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute(
        {
          filePath: "/workspace/new.ts",
          content: "hello",
        },
        { getSandbox: () => fakeAccess.get() } as any,
      ),
    )) as { existed: boolean; path: string };

    expect(result.existed).toBe(false);
    expect(result.path).toBe("/workspace/new.ts");
    expect(files["/workspace/new.ts"]).toBe("hello");
  });

  it("throws a clear error when no sandbox session is available", async () => {
    const fakeAccess: SandboxAccess = {
      async captureState() {
        return { initialized: false, session: null };
      },

      async get() {
        return null;
      },
    };

    const tool = defineWriteFileTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await expect(
      contextStorage.run(ctx, async () =>
        tool.execute({ filePath: "/workspace/foo.ts", content: "x" }, {
          getSandbox: () =>
            Promise.reject(
              new Error("The sandbox is not available in the current runtime context."),
            ),
        } as any),
      ),
    ).rejects.toThrow("The sandbox is not available in the current runtime context.");
  });

  it("rejects overwrite of existing file without prior read", async () => {
    const fakeAccess = createFakeAccess({ "/workspace/foo.ts": "original" });

    const tool = defineWriteFileTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await expect(
      contextStorage.run(ctx, async () =>
        tool.execute(
          {
            filePath: "/workspace/foo.ts",
            content: "new content",
          },
          { getSandbox: () => fakeAccess.get() } as any,
        ),
      ),
    ).rejects.toThrow(
      "You must read file /workspace/foo.ts before overwriting it. Use the read_file tool first.",
    );
  });

  it("overwrites an existing file after prior read", async () => {
    const files: Record<string, string> = { "/workspace/foo.ts": "original" };
    const fakeAccess = createFakeAccess(files);

    const tool = defineWriteFileTool();

    const stamp = createReadFileStamp({
      content: "original",
      filePath: "/workspace/foo.ts",
    });

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);
    ctx.set(ReadFileStateKey, {
      byTarget: { "/workspace/foo.ts": stamp },
    });

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute(
        {
          filePath: "/workspace/foo.ts",
          content: "new content",
        },
        { getSandbox: () => fakeAccess.get() } as any,
      ),
    )) as { existed: boolean };

    expect(result.existed).toBe(true);
    expect(files["/workspace/foo.ts"]).toBe("new content");
  });
});
