import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import { defineReadFileTool } from "../src/public/tools/define-read-file-tool.js";
import { ReadFileStateKey } from "../src/runtime/framework-tools/file-state.js";

function createFakeAccess(files: Record<string, string>): SandboxAccess {
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
        async writeTextFile() {},
      };
    },
  };
}

describe("defineReadFileTool", () => {
  it("produces a schema that never exposes a sandbox property to the model", () => {
    const tool = defineReadFileTool();

    expect(tool).not.toHaveProperty("name");
    expect(tool.description).toBe("Read a file from the workspace sandbox.");
    expect(typeof tool.execute).toBe("function");

    const schema = tool.inputSchema as unknown as Record<string, unknown>;
    expect(schema).toMatchObject({
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
      type: "object",
    });
    expect((schema.properties as Record<string, unknown>).sandbox).toBeUndefined();
  });

  it("uses an authored description when provided", () => {
    const tool = defineReadFileTool({
      description: "Read files from the repo.",
    });

    expect(tool.description).toBe("Read files from the repo.");
  });

  it("dispatches read_file calls to the agent's sandbox", async () => {
    const fakeAccess = createFakeAccess({ "/workspace/foo.ts": "line1\nline2\n" });

    const tool = defineReadFileTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute(
        {
          filePath: "/workspace/foo.ts",
        },
        { getSandbox: () => fakeAccess.get() } as any,
      ),
    )) as { content: string; totalLines: number };

    expect(result.totalLines).toBe(2);
    expect(result.content).toContain("1: line1");
    expect(result.content).toContain("2: line2");
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

    const tool = defineReadFileTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);
    ctx.set(ReadFileStateKey, { byTarget: {} });

    await expect(
      contextStorage.run(ctx, async () =>
        tool.execute({ filePath: "/workspace/foo.ts" }, {
          getSandbox: () =>
            Promise.reject(
              new Error("The sandbox is not available in the current runtime context."),
            ),
        } as any),
      ),
    ).rejects.toThrow("The sandbox is not available in the current runtime context.");
  });
});
