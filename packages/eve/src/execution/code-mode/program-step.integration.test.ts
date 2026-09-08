import { jsonSchema, type ToolSet } from "ai";
import { experimental_createCodeModeTool } from "#compiled/@ai-sdk/code-mode/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  continueWorkflowSandboxInterrupt,
  createWorkflowSandboxTool,
  getWorkflowSandboxPendingInterrupts,
  readWorkflowSandboxResolution,
  readWorkflowSandboxProgramFailure,
  requestWorkflowSandboxInterrupt,
  unwrapWorkflowSandboxResult,
} from "#shared/workflow-sandbox.js";
import {
  applyCodeModeTool,
  createDiscoveryTools,
  codeModeBridgeRequestLimit,
} from "#harness/code-mode.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { always } from "#tools/approval/policies.js";
import {
  parseCodeModeWorkflowInput,
  serializeCodeModeWorkflowInput,
} from "#execution/code-mode/schema.js";
import {
  CODE_MODE_CALL_INTERRUPT_KIND,
  createCodeModeToolStub,
} from "#execution/code-mode/program-step.js";
import type { CodeModeCallResolution } from "#execution/code-mode/schema.js";

const security = { signingKey: "code-mode-program-step-test" };

/**
 * Pins the sandbox contract `runCodeModeProgramStep` relies on: calls issued
 * together park together, resolutions are applied by position without
 * re-running the program, and the program observes every value once the last
 * resolution lands. If `@ai-sdk/code-mode` changes this, the body's batch
 * settle would silently serialize or misroute, so this test fails first.
 */
describe("code-mode sandbox continuation contract", () => {
  it("discovers every direct tool across a program resume", async () => {
    const execute = vi.fn(async () => "must stay direct");
    const definitions = new Map<string, HarnessToolDefinition>([
      [
        "echo",
        {
          name: "echo",
          description: "Echo",
          inputSchema: jsonSchema({ type: "object" }),
          execute,
        },
      ],
      [
        "gated",
        {
          name: "gated",
          description: "Needs approval",
          inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
          approval: always(),
          execute,
        },
      ],
      [
        "background",
        {
          name: "background",
          description: "Background task",
          inputSchema: jsonSchema({ type: "object" }),
          execution: "background",
          execute,
        },
      ],
      [
        "provider",
        {
          name: "provider",
          description: "Provider tool",
          inputSchema: jsonSchema({ type: "object" }),
        },
      ],
      [
        "connection_search",
        {
          name: "connection_search",
          description: "Discover connection tools",
          inputSchema: jsonSchema({ type: "object" }),
          execute,
        },
      ],
      [
        "code_mode",
        {
          name: "code_mode",
          description: "Run a program",
          inputSchema: jsonSchema({ type: "object" }),
          workflowId: "workflow//eve//codeModeWorkflow",
        },
      ],
    ]);
    const applied = await applyCodeModeTool({
      continuationSecurity: security,
      harnessTools: definitions,
      tools: buildToolSet({ tools: definitions }),
    });
    const program = parseCodeModeWorkflowInput(
      applied.harnessTools.get("code_mode")!.executeInput!({
        js: [
          "const before = await tools.search_tools({});",
          'const schemas = await tools.describe_tools({ names: ["gated", "provider", "unknown"] });',
          "const result = await tools.echo({});",
          "return { before, schemas, result, after: await tools.search_tools({}) };",
        ].join("\n"),
      }),
    );
    const hostTools = {
      echo: createCodeModeToolStub(program.toolCatalog.find((entry) => entry.name === "echo")!),
      ...createDiscoveryTools(program.toolCatalog),
    };
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: codeModeBridgeRequestLimit(100),
      continuationSecurity: security,
      hostTools,
    });
    const parked = await unwrapWorkflowSandboxResult(
      await tool.execute!({ js: program.js } as never, { toolCallId: "discovery" } as never),
      security,
    );
    if (parked.status !== "interrupted") throw new Error("Expected echo to park");
    const restored = parseCodeModeWorkflowInput(
      JSON.parse(JSON.stringify(serializeCodeModeWorkflowInput(program))),
    );
    const resumed = await unwrapWorkflowSandboxResult(
      await continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: codeModeBridgeRequestLimit(100),
        continuationSecurity: security,
        interrupt: parked.interrupt,
        resolution: { status: "completed", output: "done" },
        tools: { echo: hostTools.echo, ...createDiscoveryTools(restored.toolCatalog) },
      }),
      security,
    );
    const names = program.toolCatalog.map(({ name, description, target }) => ({
      name,
      description,
      requiresDirectCall: target === "direct",
    }));
    expect(resumed).toEqual({
      status: "completed",
      output: {
        before: names,
        after: names,
        result: "done",
        schemas: [
          {
            name: "gated",
            description: "Needs approval",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
            requiresDirectCall: true,
          },
          {
            name: "provider",
            description: "Provider tool",
            inputSchema: { type: "object" },
            requiresDirectCall: true,
          },
          { error: "unknown tool", name: "unknown" },
        ],
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("makes a failed call catchable and retryable without repeating a completed sibling", async () => {
    const hostTools = Object.fromEntries(
      ["child", "sibling"].map((name) => [
        name,
        createCodeModeToolStub({
          name,
          description: name,
          inputSchema: { type: "object" },
          outputSchema: null,
          target: name === "child" ? "agent" : "tool",
        }),
      ]),
    ) as ToolSet;
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: codeModeBridgeRequestLimit(100),
      continuationSecurity: security,
      hostTools,
    });
    const first = await unwrapWorkflowSandboxResult(
      await tool.execute!(
        {
          js: [
            "const results = await Promise.allSettled([tools.child({}), tools.sibling({})]);",
            "let caught;",
            "try { await tools.child({ retry: true }); } catch (error) { caught = error.message; }",
            "return { statuses: results.map(r => r.status), error: results[0].reason.message, sibling: results[1].value, caught };",
          ].join("\n"),
        } as never,
        { toolCallId: "outer" } as never,
      ),
      security,
    );
    if (first.status !== "interrupted") throw new Error("expected park");
    let current = first.interrupt;
    const resolutions: CodeModeCallResolution[] = [
      { status: "failed", error: "Child failed" },
      { status: "completed", output: { error: "ordinary output" } },
      { status: "failed", error: "Retry failed" },
    ];
    for (const [index, resolution] of resolutions.entries()) {
      const resumed = await unwrapWorkflowSandboxResult(
        await continueWorkflowSandboxInterrupt({
          bridgeRequestLimit: codeModeBridgeRequestLimit(100),
          continuationSecurity: security,
          interrupt: current,
          resolution,
          tools: hostTools,
        }),
        security,
      );
      if (index < 2) {
        if (resumed.status !== "interrupted") throw new Error("expected remaining call");
        const pending = getWorkflowSandboxPendingInterrupts(resumed.interrupt);
        expect(pending.map((p) => p.toolName)).toEqual(index === 0 ? ["sibling"] : ["child"]);
        if (index === 1) expect(pending[0]?.input).toEqual({ retry: true });
        current = pending[0]!;
      } else {
        expect(resumed).toEqual({
          status: "completed",
          output: {
            statuses: ["rejected", "fulfilled"],
            error: "Child failed",
            sibling: { error: "ordinary output" },
            caught: "Retry failed",
          },
        });
      }
    }
  });

  it("parks a Promise.all batch together and resumes once with all values", async () => {
    let hostCalls = 0;
    const stub = (name: string): ToolSet[string] =>
      ({
        description: name,
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (toolInput: unknown, options: unknown) => {
          const resolution = readWorkflowSandboxResolution(options);
          if (resolution !== undefined) return resolution;
          hostCalls++;
          return requestWorkflowSandboxInterrupt({
            kind: CODE_MODE_CALL_INTERRUPT_KIND,
            target: "tool",
            toolInput,
            toolName: name,
          });
        },
      }) as ToolSet[string];
    const hostTools = { a: stub("a"), b: stub("b"), c: stub("c") } as ToolSet;

    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: codeModeBridgeRequestLimit(100),
      continuationSecurity: security,
      hostTools,
    });
    const first = await unwrapWorkflowSandboxResult(
      await tool.execute!(
        {
          js: [
            "const [x, y, z] = await Promise.all([",
            "  tools.a({ i: 1 }), tools.b({ i: 2 }), tools.c({ i: 3 }),",
            "]);",
            "return { sum: x + y + z, order: [x, y, z] };",
          ].join("\n"),
        } as never,
        { toolCallId: "outer" } as never,
      ),
      security,
    );

    expect(first.status).toBe("interrupted");
    if (first.status !== "interrupted") return;
    const pending = getWorkflowSandboxPendingInterrupts(first.interrupt);
    expect(pending.map((p) => p.toolName)).toEqual(["a", "b", "c"]);
    expect(pending.map((p) => p.input)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(hostCalls).toBe(3);

    // Resolve in ledger order. The first two must return a new interrupt
    // without running anything; the third resumes the program.
    let raw: unknown;
    let current = pending[0]!;
    const resolutions = [10, 20, 30];
    for (const [index, resolution] of resolutions.entries()) {
      raw = await continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: codeModeBridgeRequestLimit(100),
        continuationSecurity: security,
        interrupt: current,
        resolution,
        tools: hostTools,
      });
      const unwrapped = await unwrapWorkflowSandboxResult(raw, security);
      if (index < resolutions.length - 1) {
        expect(unwrapped.status).toBe("interrupted");
        expect(hostCalls).toBe(3);
        if (unwrapped.status !== "interrupted") return;
        const next = getWorkflowSandboxPendingInterrupts(unwrapped.interrupt);
        expect(next.map((p) => p.toolName)).toEqual(
          pending.slice(index + 1).map((p) => p.toolName),
        );
        current = next[0]!;
      }
    }
    // Resuming replays the program to the park point; replayed stubs return
    // the settled value instead of raising, so no new host call is counted.
    const final = await unwrapWorkflowSandboxResult(raw, security);
    expect(final).toEqual({ output: { order: [10, 20, 30], sum: 60 }, status: "completed" });
    expect(hostCalls).toBe(3);
  });

  it("rejects a resolution for the wrong pending interrupt", async () => {
    const stub = (name: string): ToolSet[string] =>
      ({
        description: name,
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (toolInput: unknown) =>
          requestWorkflowSandboxInterrupt({
            kind: CODE_MODE_CALL_INTERRUPT_KIND,
            target: "tool",
            toolInput,
            toolName: name,
          }),
      }) as ToolSet[string];
    const hostTools = { a: stub("a"), b: stub("b") } as ToolSet;
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: codeModeBridgeRequestLimit(100),
      continuationSecurity: security,
      hostTools,
    });
    const first = await unwrapWorkflowSandboxResult(
      await tool.execute!(
        { js: "return await Promise.all([tools.a({}), tools.b({})]);" } as never,
        { toolCallId: "outer" } as never,
      ),
      security,
    );
    if (first.status !== "interrupted") throw new Error("expected park");
    const [, second] = getWorkflowSandboxPendingInterrupts(first.interrupt);

    await expect(
      continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: codeModeBridgeRequestLimit(100),
        continuationSecurity: security,
        interrupt: second!,
        resolution: 1,
        tools: hostTools,
      }),
    ).rejects.toThrow(/does not match the (next pending|signed continuation ledger)/u);
  });

  it("rejects a resume whose tool catalog drifted from the parked one", async () => {
    const stub = (name: string): ToolSet[string] =>
      ({
        description: name,
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (toolInput: unknown) =>
          requestWorkflowSandboxInterrupt({
            kind: CODE_MODE_CALL_INTERRUPT_KIND,
            target: "tool",
            toolInput,
            toolName: name,
          }),
      }) as ToolSet[string];
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: codeModeBridgeRequestLimit(100),
      continuationSecurity: security,
      hostTools: { a: stub("a") } as ToolSet,
    });
    const first = await unwrapWorkflowSandboxResult(
      await tool.execute!(
        { js: "return await tools.a({});" } as never,
        {
          toolCallId: "outer",
        } as never,
      ),
      security,
    );
    if (first.status !== "interrupted") throw new Error("expected park");

    await expect(
      continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: codeModeBridgeRequestLimit(100),
        continuationSecurity: security,
        interrupt: getWorkflowSandboxPendingInterrupts(first.interrupt)[0]!,
        resolution: 1,
        tools: { a: stub("a"), extra: stub("extra") } as ToolSet,
      }),
    ).rejects.toThrow(/tool names do not match/u);
  });
});

describe("compiled sandbox suspension and failure boundaries", () => {
  it.each([
    "try { value = await tools.pause({}); } catch { for (let i = 0; i < 100000; i++) {} }",
    "try { value = await tools.pause({}); } finally { for (let i = 0; i < 100000; i++) {} await tools.cleanup({}); }",
  ])("parks without executing guest exception handlers: %s", async (source) => {
    const effect = vi.fn(async () => "created");
    const cleanup = vi.fn(async () => "cleaned");
    const hostTools = {
      effect: { inputSchema: jsonSchema({ type: "object" }), execute: effect },
      cleanup: { inputSchema: jsonSchema({ type: "object" }), execute: cleanup },
      pause: createCodeModeToolStub({
        name: "pause",
        description: "Pause",
        inputSchema: { type: "object" },
        outputSchema: null,
        target: "tool",
      }),
    };
    const sandbox = experimental_createCodeModeTool(hostTools, {
      continuationSecurity: security,
      executionPolicy: { timeoutMs: 1000 },
    });
    const parked = await unwrapWorkflowSandboxResult(
      await sandbox.execute!(
        { js: `await tools.effect({}); let value; ${source}; return value;` },
        { toolCallId: "suspension", messages: [], context: {} },
      ),
      security,
    );
    expect(parked.status).toBe("interrupted");
    if (parked.status !== "interrupted") throw new Error("Expected suspension");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    const resumed = await unwrapWorkflowSandboxResult(
      await continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: codeModeBridgeRequestLimit(100),
        continuationSecurity: security,
        interrupt: parked.interrupt,
        resolution: { status: "completed", output: 42 },
        tools: hostTools,
      }),
      security,
    );
    expect(resumed).toEqual({ status: "completed", output: 42 });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(source.includes("finally") ? 1 : 0);
    expect(
      await unwrapWorkflowSandboxResult(
        await sandbox.execute!(
          { js: "return 43;" },
          { toolCallId: "recovery", messages: [], context: {} },
        ),
        security,
      ),
    ).toEqual({ status: "completed", output: 43 });
  });

  it.each([
    "return (;",
    "throw new Error('guest failure');",
    "throw 'guest primitive';",
    "throw Object.assign(new Error('guest failure'), { code: 'RUN_PROTOCOL_ERROR' });",
  ])("identifies guest source failures without trusting guest error codes: %s", async (js) => {
    const sandbox = experimental_createCodeModeTool({}, { executionPolicy: { timeoutMs: 1000 } });
    const error = await Promise.resolve(
      sandbox.execute!({ js }, { toolCallId: "invalid-source", messages: [], context: {} }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "RUN_USER_SOURCE_ERROR" });
    expect(readWorkflowSandboxProgramFailure(error)).toEqual(expect.any(String));
  });

  it("keeps a real CPU timeout distinct and accepts a subsequent valid program", async () => {
    const sandbox = experimental_createCodeModeTool({}, { executionPolicy: { timeoutMs: 100 } });
    const error = await Promise.resolve(
      sandbox.execute!({ js: "while (true) {}" }, { toolCallId: "cpu", messages: [], context: {} }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "CODE_MODE_TIMEOUT" });
    expect(readWorkflowSandboxProgramFailure(error)).toBeUndefined();
    expect(
      await unwrapWorkflowSandboxResult(
        await sandbox.execute!(
          { js: "return 42;" },
          { toolCallId: "recovered", messages: [], context: {} },
        ),
        security,
      ),
    ).toEqual({ status: "completed", output: 42 });
  });
});
