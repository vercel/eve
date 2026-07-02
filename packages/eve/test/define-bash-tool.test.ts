import { describe, expect, it } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { ContextContainer, contextStorage } from "../src/context/container.js";
import { SandboxKey } from "../src/context/keys.js";
import type { SandboxAccess } from "../src/sandbox/state.js";
import { defineBashTool } from "../src/public/tools/define-bash-tool.js";

describe("defineBashTool", () => {
  it("produces a schema that never exposes a sandbox property to the model", () => {
    const tool = defineBashTool();

    expect(tool).not.toHaveProperty("name");
    expect(tool.description).toBe("Execute a shell command in the workspace sandbox.");
    expect(typeof tool.execute).toBe("function");

    const schema = tool.inputSchema as unknown as Record<string, unknown>;
    expect(schema).toMatchObject({
      properties: { command: { type: "string" } },
      required: ["command"],
      type: "object",
    });
    expect((schema.properties as Record<string, unknown>).sandbox).toBeUndefined();
  });

  it("uses an authored description when provided", () => {
    const tool = defineBashTool({
      description: "Run shell commands in the cloned repo.",
    });

    expect(tool.description).toBe("Run shell commands in the cloned repo.");
  });

  it("dispatches shell commands to the agent's sandbox", async () => {
    const recordedCommands: { command: string }[] = [];
    const fakeAccess: SandboxAccess = {
      async captureState() {
        return {
          initialized: false,
          session: null,
        };
      },

      async get() {
        return {
          id: "test-bash-sandbox",
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
            recordedCommands.push({ command });
            return { exitCode: 0, stderr: "", stdout: `stdout:${command}` };
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

    const tool = defineBashTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    const result = await contextStorage.run(ctx, async () =>
      tool.execute({ command: "echo hi" }, { getSandbox: () => fakeAccess.get() } as any),
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "stdout:echo hi", truncated: false });
    expect(recordedCommands).toEqual([{ command: "echo hi" }]);
  });

  // ---------------------------------------------------------------------------
  // Error case
  // ---------------------------------------------------------------------------

  it("throws a clear error when no sandbox session is available", async () => {
    const fakeAccess: SandboxAccess = {
      async captureState() {
        return {
          initialized: false,
          session: null,
        };
      },

      async get() {
        return null;
      },
    };

    const tool = defineBashTool();

    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    await expect(
      contextStorage.run(ctx, async () =>
        tool.execute({ command: "echo" }, {
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

  it("truncates large stdout and preserves the tail", async () => {
    const largeOutput = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
    const fakeAccess: SandboxAccess = {
      async captureState() {
        return { initialized: false, session: null };
      },

      async get() {
        return {
          id: "test-bash-sandbox-large",
          async readFile() {
            return null;
          },
          async run() {
            return { exitCode: 0, stderr: "", stdout: largeOutput };
          },
          async spawn() {
            return stubSpawnProcess();
          },
          async writeFile() {},
          async writeBinaryFile() {},
          async writeTextFile() {},
          async readBinaryFile() {
            return null;
          },
          async readTextFile() {
            return null;
          },
          async setNetworkPolicy() {},
          async removePath() {},
          resolvePath(arg: string) {
            return arg;
          },
        };
      },
    };

    const tool = defineBashTool();
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, fakeAccess);

    const result = (await contextStorage.run(ctx, async () =>
      tool.execute({ command: "seq 3000" }, { getSandbox: () => fakeAccess.get() } as any),
    )) as { exitCode: number; stderr: string; stdout: string; truncated: boolean };

    expect(result.truncated).toBe(true);
    // Should keep the tail (last lines)
    expect(result.stdout).toContain("line 3000");
    // Should have the truncation notice
    expect(result.stdout).toContain("[stdout truncated:");
  });
});
