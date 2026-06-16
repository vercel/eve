import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import { defineGlobTool } from "../src/public/tools/define-glob-tool.js";

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

describe("defineGlobTool", () => {
  it("produces a schema that never exposes a sandbox property to the model", () => {
    const tool = defineGlobTool();

    expect(tool).not.toHaveProperty("name");
    expect(tool.description).toBe("Search for files by glob pattern in the workspace sandbox.");
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
    const tool = defineGlobTool({
      description: "Search for files in the repo.",
    });

    expect(tool.description).toBe("Search for files in the repo.");
  });

  it("dispatches glob commands to the agent's sandbox", async () => {
    const fakeAccess = createFakeAccess(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "/workspace/foo.ts\n",
    }));

    const tool = defineGlobTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute({ pattern: "**/*.ts" }, { getSandbox: () => fakeAccess.get() } as any),
    )) as { content: string; count: number };

    expect(result.count).toBe(1);
    expect(result.content).toContain("/workspace/foo.ts");
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

    const tool = defineGlobTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    await expect(
      contextStorage.run(ctx, async () =>
        tool.execute({ pattern: "**/*.ts" }, {
          getSandbox: () =>
            Promise.reject(
              new Error("The sandbox is not available in the current runtime context."),
            ),
        } as any),
      ),
    ).rejects.toThrow("The sandbox is not available in the current runtime context.");
  });

  // ---------------------------------------------------------------------------
  // Truncation
  // ---------------------------------------------------------------------------

  it("truncates results that exceed the byte cap", async () => {
    // Generate 500 very long file paths (~200 chars each) = ~100KB > 50KB limit
    const longPaths = Array.from(
      { length: 500 },
      (_, i) => `/workspace/deeply/nested/${"sub/".repeat(20)}file_${i}.ts`,
    );
    const fakeAccess = createFakeAccess(() => ({
      exitCode: 0,
      stderr: "",
      stdout: longPaths.join("\n"),
    }));

    const tool = defineGlobTool();
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute(
        {
          pattern: "**/*.ts",
          limit: 500,
        },
        { getSandbox: () => fakeAccess.get() } as any,
      ),
    )) as { content: string; count: number; truncated: boolean };

    expect(result.truncated).toBe(true);
    expect(result.count).toBeLessThan(500);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(60_000);
  });
});
