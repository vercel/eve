import { describe, expect, it } from "vitest";

import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

describe("buildBaseToolContext – getSandbox abort binding", () => {
  it("returns a session bound to the turn abort signal", async () => {
    let observed: AbortSignal | undefined;
    const sandbox = mockSandbox({
      run: (options) => {
        observed = options.abortSignal;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const runtime = createTestRuntime();
    const controller = new AbortController();

    await runtime.runAsSession({ sandbox }, async () => {
      const ctx = buildBaseToolContext({
        options: { abortSignal: controller.signal, toolCallId: "call_1" },
        toolName: "shell",
      });
      expect(ctx.toolName).toBe("shell");
      const live = await ctx.getSandbox();
      await live.run({ command: "echo ready" });
    });

    expect(observed).toBe(controller.signal);
  });

  it("binds the inert fallback signal when no turn signal exists", async () => {
    let observed: AbortSignal | undefined;
    const sandbox = mockSandbox({
      run: (options) => {
        observed = options.abortSignal;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const runtime = createTestRuntime();

    await runtime.runAsSession({ sandbox }, async () => {
      const ctx = buildBaseToolContext({
        options: { toolCallId: "call_1" },
        toolName: "shell",
      });
      const live = await ctx.getSandbox();
      await live.run({ command: "echo ready" });
    });

    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(false);
  });
});
