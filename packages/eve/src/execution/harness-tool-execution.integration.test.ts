import { describe, expect, it } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";

/**
 * Integration coverage for authored tool execution through the harness.
 *
 * Replaces the `test/harness-tool-execution.integration.test.ts` fixture —
 * these cases exercise the same seam (tool execute, error propagation,
 * session and sandbox exposure) through the AppHarness. No test body
 * touches `mkdtemp`, `installBundledCompiledArtifacts`, or real sandboxes.
 */

const WEATHER_INPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    city: {
      type: "string",
    },
  },
  required: ["city"],
  type: "object",
};

describe("authored tool execution", () => {
  it("executes authored tools through the harness-owned pipeline", async () => {
    const weatherTool = mockTool({
      name: "get_weather",
      description: "Get the weather.",
      inputSchema: WEATHER_INPUT_SCHEMA,
      execute(input) {
        return {
          city: (input as { city: string }).city,
          temperatureF: 72,
        };
      },
    });
    const runtime = await createTestRuntime({ tools: [weatherTool] });

    const result = await runtime.runAsSession(undefined, async () => {
      return await runtime.executeTool(weatherTool, { city: "Brooklyn" });
    });

    expect(result).toEqual({
      city: "Brooklyn",
      temperatureF: 72,
    });
  });

  it("propagates authored execution failures as exceptions", async () => {
    const weatherTool = mockTool({
      name: "get_weather",
      description: "Get the weather.",
      inputSchema: WEATHER_INPUT_SCHEMA,
      execute() {
        throw new Error("weather upstream unavailable");
      },
    });
    const runtime = await createTestRuntime({ tools: [weatherTool] });

    await expect(
      runtime.runAsSession(undefined, async () => {
        return await runtime.executeTool(weatherTool, { city: "Brooklyn" });
      }),
    ).rejects.toThrow("weather upstream unavailable");
  });

  it("exposes session metadata to authored tool execution across async work", async () => {
    const sessionProbe = mockTool({
      name: "session_probe",
      async execute(_input, ctx) {
        await Promise.resolve();
        return ctx.session;
      },
    });
    const runtime = await createTestRuntime({ tools: [sessionProbe] });

    const result = await runtime.runAsSession(
      {
        sessionId: "session_async_session",
        turn: { id: "turn_async_session_001", sequence: 1 },
      },
      async () => runtime.executeTool(sessionProbe, {}),
    );

    expect(result).toEqual({
      auth: {
        current: null,
        initiator: null,
      },
      id: "session_async_session",
      context: {},
      turn: {
        id: "turn_async_session_001",
        sequence: 1,
      },
    });
  });

  it("exposes parent session lineage to authored child tool execution", async () => {
    const sessionProbe = mockTool({
      name: "session_probe",
      execute(_input, ctx) {
        return ctx.session;
      },
    });
    const runtime = await createTestRuntime({ tools: [sessionProbe] });

    const result = await runtime.runAsSession(
      {
        parent: {
          callId: "call_parent_001",
          rootSessionId: "session_parent",
          sessionId: "session_parent",
          turn: { id: "turn_parent_001", sequence: 4 },
        },
        sessionId: "session_child",
        turn: { id: "turn_child_001", sequence: 1 },
      },
      async () => runtime.executeTool(sessionProbe, {}),
    );

    expect(result).toEqual({
      auth: {
        current: null,
        initiator: null,
      },
      parent: {
        callId: "call_parent_001",
        rootSessionId: "session_parent",
        sessionId: "session_parent",
        turn: { id: "turn_parent_001", sequence: 4 },
      },
      id: "session_child",
      context: {},
      turn: { id: "turn_child_001", sequence: 1 },
    });
  });

  it("allows authored tools to lazily resolve the sandbox through ctx.getSandbox()", async () => {
    const sandbox = mockSandbox({ id: "sbx_tool" });
    const sandboxTool = mockTool({
      name: "sandbox_probe",
      async execute(_input, ctx) {
        const live = await ctx.getSandbox();
        await live.writeTextFile({ content: "sandbox-note", path: "note.txt" });
        const content = await live.readTextFile({ path: "note.txt" });
        return { content };
      },
    });
    const runtime = await createTestRuntime({ tools: [sandboxTool] });

    const result = (await runtime.runAsSession({ sandbox }, async () =>
      runtime.executeTool(sandboxTool, {}),
    )) as { content: string };

    expect(result.content).toBe("sandbox-note");
    expect(sandbox.files.get("/workspace/note.txt")).toBe("sandbox-note");
  });

  it("lets authored tools resolve backend-native sandbox paths through ctx.getSandbox()", async () => {
    const sandbox = mockSandbox({
      id: "sbx_resolve",
      run: async ({ command }) => {
        if (command.includes("/workspace/reports/output.txt")) {
          return { exitCode: 0, stderr: "", stdout: "resolved-path\n" };
        }

        return { exitCode: 1, stderr: `unexpected command: ${command}`, stdout: "" };
      },
    });
    const resolveTool = mockTool({
      name: "sandbox_resolve",
      async execute(_input, ctx) {
        const live = await ctx.getSandbox();
        const reportPath = live.resolvePath("/workspace/reports/output.txt");
        await live.writeTextFile({
          content: "resolved-path",
          path: "/workspace/reports/output.txt",
        });
        const result = await live.run({ command: `cat ${JSON.stringify(reportPath)}` });
        return { reportPath, stdout: result.stdout.trim() };
      },
    });
    const runtime = await createTestRuntime({ tools: [resolveTool] });

    const result = await runtime.runAsSession({ sandbox }, async () =>
      runtime.executeTool(resolveTool, {}),
    );

    expect(result).toEqual({
      reportPath: "/workspace/reports/output.txt",
      stdout: "resolved-path",
    });
  });
});
