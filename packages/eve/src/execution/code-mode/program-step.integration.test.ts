import { jsonSchema, type ToolSet } from "ai";
import {
  experimental_createCodeModeTool,
  experimental_requestCodeModeInterrupt,
} from "#compiled/@ai-sdk/code-mode/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  createParkingHostTool,
  createWorkflowSandbox,
  type WorkflowSandbox,
  type WorkflowSandboxOutcome,
  type WorkflowSandboxResolution,
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

const security = { signingKey: "code-mode-program-step-test" };

const sandboxFor = (hostTools: ToolSet): Promise<WorkflowSandbox> =>
  createWorkflowSandbox({
    bridgeRequestLimit: codeModeBridgeRequestLimit(100),
    continuationSecurity: security,
    hostTools,
  });

function parkedOutcome(outcome: WorkflowSandboxOutcome) {
  if (outcome.status !== "interrupted") throw new Error(`expected park, got ${outcome.status}`);
  return outcome;
}

const completed = (output: unknown): WorkflowSandboxResolution => ({
  status: "completed",
  output: output as never,
});

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
          'const matches = await tools.search_tools({ query: "APPROVAL nonexistentkeyword" });',
          'const schemas = await tools.describe_tools({ names: ["gated", "provider", "unknown"] });',
          "const result = await tools.echo({});",
          'return { before, schemas, result, after: await tools.search_tools({}), matches: matches.map(tool => tool.name), resumedMatches: (await tools.search_tools({ query: "approval nonexistentkeyword" })).map(tool => tool.name) };',
        ].join("\n"),
      }),
    );
    const echo = createCodeModeToolStub(
      program.toolCatalog.find((entry) => entry.name === "echo")!,
    );
    const sandbox = await sandboxFor({ echo, ...createDiscoveryTools(program.toolCatalog) });
    const parked = parkedOutcome(await sandbox.run({ js: program.js, toolCallId: "discovery" }));
    const restored = parseCodeModeWorkflowInput(
      JSON.parse(JSON.stringify(serializeCodeModeWorkflowInput(program))),
    );
    // A fresh sandbox over the restored catalog: the step rebuilds its host
    // tools from the durable input on every replay.
    const resumed = await (
      await sandboxFor({ echo, ...createDiscoveryTools(restored.toolCatalog) })
    ).resume({ interrupt: parked.interrupt, resolutions: [completed("done")] });
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
        matches: ["gated"],
        resumedMatches: ["gated"],
        schemas: [
          {
            name: "gated",
            description: "Needs approval",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
            requiresDirectCall: false,
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
    const sandbox = await sandboxFor(hostTools);
    const first = parkedOutcome(
      await sandbox.run({
        js: [
          "const results = await Promise.allSettled([tools.child({}), tools.sibling({})]);",
          "let caught;",
          "try { await tools.child({ retry: true }); } catch (error) { caught = error.message; }",
          "return { statuses: results.map(r => r.status), error: results[0].reason.message, sibling: results[1].value, caught };",
        ].join("\n"),
        toolCallId: "outer",
      }),
    );
    expect(first.pending.map((p) => p.toolName)).toEqual(["child", "sibling"]);

    // Settle the first batch: the failure and its successful sibling together.
    const retry = parkedOutcome(
      await sandbox.resume({
        interrupt: first.interrupt,
        resolutions: [
          { status: "failed", error: "Child failed" },
          completed({ error: "ordinary output" }),
        ],
      }),
    );
    expect(retry.pending.map((p) => p.toolName)).toEqual(["child"]);
    expect(retry.pending[0]?.input).toEqual({ retry: true });

    await expect(
      sandbox.resume({
        interrupt: retry.interrupt,
        resolutions: [{ status: "failed", error: "Retry failed" }],
      }),
    ).resolves.toEqual({
      status: "completed",
      output: {
        statuses: ["rejected", "fulfilled"],
        error: "Child failed",
        sibling: { error: "ordinary output" },
        caught: "Retry failed",
      },
    });
  });

  it("parks a Promise.all batch together and resumes once with all values", async () => {
    let hostCalls = 0;
    // A hand-rolled stub so the test can count how often the host is asked.
    const stub = (name: string): ToolSet[string] =>
      ({
        description: name,
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (toolInput: unknown, options: unknown) => {
          const resolution = (options as { codeModeInterrupt?: { resolution?: unknown } })
            .codeModeInterrupt?.resolution as WorkflowSandboxResolution | undefined;
          if (resolution?.status === "completed") return resolution.output;
          hostCalls++;
          return experimental_requestCodeModeInterrupt({
            kind: CODE_MODE_CALL_INTERRUPT_KIND,
            target: "tool",
            toolInput,
            toolName: name,
          });
        },
      }) as ToolSet[string];
    const hostTools = { a: stub("a"), b: stub("b"), c: stub("c") } as ToolSet;
    const sandbox = await sandboxFor(hostTools);
    const first = parkedOutcome(
      await sandbox.run({
        js: [
          "const [x, y, z] = await Promise.all([",
          "  tools.a({ i: 1 }), tools.b({ i: 2 }), tools.c({ i: 3 }),",
          "]);",
          "return { sum: x + y + z, order: [x, y, z] };",
        ].join("\n"),
        toolCallId: "outer",
      }),
    );

    expect(first.pending.map((p) => p.toolName)).toEqual(["a", "b", "c"]);
    expect(first.pending.map((p) => p.input)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(hostCalls).toBe(3);

    // Resolving the whole batch in ledger order replays the program to the
    // park point once; replayed stubs return the settled value instead of
    // raising, so no new host call is counted.
    const final = await sandbox.resume({
      interrupt: first.interrupt,
      resolutions: [completed(10), completed(20), completed(30)],
    });
    expect(final).toEqual({ output: { order: [10, 20, 30], sum: 60 }, status: "completed" });
    expect(hostCalls).toBe(3);
  });

  it("rejects a batch whose resolution count does not match the parked calls", async () => {
    const hostTools = {
      a: parkingTool("a"),
      b: parkingTool("b"),
    } as ToolSet;
    const sandbox = await sandboxFor(hostTools);
    const first = parkedOutcome(
      await sandbox.run({
        js: "return await Promise.all([tools.a({}), tools.b({})]);",
        toolCallId: "outer",
      }),
    );
    expect(first.pending).toHaveLength(2);

    await expect(
      sandbox.resume({ interrupt: first.interrupt, resolutions: [completed(1)] }),
    ).rejects.toThrow("Workflow sandbox resumed with 1 resolutions for 2 pending calls.");
  });

  it("rejects a resolution for the wrong pending interrupt", async () => {
    const hostTools = {
      a: parkingTool("a"),
      b: parkingTool("b"),
    } as ToolSet;
    const sandbox = await sandboxFor(hostTools);
    const first = parkedOutcome(
      await sandbox.run({
        js: "return await Promise.all([tools.a({}), tools.b({})]);",
        toolCallId: "outer",
      }),
    );
    const [, second] = first.pending;

    // `second` reconstructs the same continuation with the second call
    // selected; the SDK insists resolutions land on the next pending call.
    await expect(
      sandbox.resume({ interrupt: second!, resolutions: [completed(1), completed(2)] }),
    ).rejects.toThrow(/does not match the (next pending|signed continuation ledger)/u);
  });

  it("rejects a resume whose tool catalog drifted from the parked one", async () => {
    const sandbox = await sandboxFor({ a: parkingTool("a") } as ToolSet);
    const first = parkedOutcome(
      await sandbox.run({ js: "return await tools.a({});", toolCallId: "outer" }),
    );

    const drifted = await sandboxFor({
      a: parkingTool("a"),
      extra: parkingTool("extra"),
    } as ToolSet);
    await expect(
      drifted.resume({ interrupt: first.interrupt, resolutions: [completed(1)] }),
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
    } as ToolSet;
    const sandbox = await sandboxFor(hostTools);
    const parked = parkedOutcome(
      await sandbox.run({
        js: `await tools.effect({}); let value; ${source}; return value;`,
        toolCallId: "suspension",
      }),
    );
    expect(effect).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    const resumed = await sandbox.resume({
      interrupt: parked.interrupt,
      resolutions: [completed(42)],
    });
    expect(resumed).toEqual({ status: "completed", output: 42 });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(source.includes("finally") ? 1 : 0);
    await expect(sandbox.run({ js: "return 43;", toolCallId: "recovery" })).resolves.toEqual({
      status: "completed",
      output: 43,
    });
  });

  it.each([
    "return (;",
    "throw new Error('guest failure');",
    "throw 'guest primitive';",
    "throw Object.assign(new Error('guest failure'), { code: 'RUN_PROTOCOL_ERROR' });",
  ])("identifies guest source failures without trusting guest error codes: %s", async (js) => {
    const raw = experimental_createCodeModeTool({}, { executionPolicy: { timeoutMs: 1000 } });
    const error = await Promise.resolve(
      raw.execute!({ js }, { toolCallId: "invalid-source", messages: [], context: {} }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "RUN_USER_SOURCE_ERROR" });
    // The sandbox surfaces the same failure as data the program step can report.
    const sandbox = await sandboxFor({});
    await expect(sandbox.run({ js, toolCallId: "invalid-source" })).resolves.toEqual({
      status: "failed",
      error: expect.any(String),
    });
  });

  it("keeps a real CPU timeout distinct and accepts a subsequent valid program", async () => {
    const raw = experimental_createCodeModeTool({}, { executionPolicy: { timeoutMs: 100 } });
    const error = await Promise.resolve(
      raw.execute!({ js: "while (true) {}" }, { toolCallId: "cpu", messages: [], context: {} }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "CODE_MODE_TIMEOUT" });
    // `createWorkflowSandbox` rethrows this code instead of settling it as a
    // program failure (pinned in workflow-sandbox.test.ts); the worker pool
    // must still accept the next program.
    const sandbox = await sandboxFor({});
    await expect(sandbox.run({ js: "return 42;", toolCallId: "recovered" })).resolves.toEqual({
      status: "completed",
      output: 42,
    });
  });
});

function parkingTool(name: string): ToolSet[string] {
  return createParkingHostTool({
    description: name,
    inputSchema: { type: "object" },
    interrupt: (toolInput) => ({
      kind: CODE_MODE_CALL_INTERRUPT_KIND,
      target: "tool",
      toolInput,
      toolName: name,
    }),
  });
}
