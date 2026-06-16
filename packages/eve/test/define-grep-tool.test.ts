import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import { defineGrepTool } from "../src/public/tools/define-grep-tool.js";

function createFakeAccess(
  handler: (command: string) => { exitCode: number; stderr: string; stdout: string } | null,
): SandboxAccess {
  return {
    async captureState() {
      return { initialized: false, session: null };
    },
    async dispose() {},

    async get() {
      const callHandler = handler;
      if (callHandler === null) return null;
      return {
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
          return path;
        },
        async run({ command }: { command: string }) {
          const result = callHandler(command);
          if (result === null) {
            throw new Error("no handler");
          }
          return result;
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

describe("defineGrepTool", () => {
  it("produces a schema that never exposes a sandbox property to the model", () => {
    const tool = defineGrepTool();

    expect(tool).not.toHaveProperty("name");
    expect(tool.description).toBe("Search file contents by pattern in the workspace sandbox.");
    expect(typeof tool.execute).toBe("function");

    const schema = tool.inputSchema as unknown as Record<string, unknown>;
    expect(schema).toMatchObject({
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      type: "object",
    });
    expect((schema.properties as Record<string, unknown>).sandbox).toBeUndefined();
  });

  it("uses an authored description when provided", () => {
    const tool = defineGrepTool({
      description: "Search code in the repo.",
    });

    expect(tool.description).toBe("Search code in the repo.");
  });

  it("dispatches grep commands to the agent's sandbox", async () => {
    const fakeAccess = createFakeAccess(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "/workspace/foo.ts:10:const x = 1;\n",
    }));

    const tool = defineGrepTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute({ pattern: "const x" }, { getSandbox: () => fakeAccess.get() } as any),
    )) as { content: string; matchCount: number };

    expect(result.matchCount).toBe(1);
    expect(result.content).toContain("/workspace/foo.ts:10:const x = 1;");
  });

  it("throws a clear error when no sandbox session is available", async () => {
    const fakeAccess: SandboxAccess = {
      async captureState() {
        return { initialized: false, session: null };
      },
      async dispose() {},

      async get() {
        return null;
      },
    };

    const tool = defineGrepTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    await expect(
      contextStorage.run(ctx, async () =>
        tool.execute({ pattern: "foo" }, {
          getSandbox: () =>
            Promise.reject(
              new Error("The sandbox is not available in the current runtime context."),
            ),
        } as any),
      ),
    ).rejects.toThrow("The sandbox is not available in the current runtime context.");
  });
});
