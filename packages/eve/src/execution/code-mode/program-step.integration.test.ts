import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import {
  continueWorkflowSandboxInterrupt,
  createWorkflowSandboxTool,
  getWorkflowSandboxPendingInterrupts,
  readWorkflowSandboxResolution,
  requestWorkflowSandboxInterrupt,
  unwrapWorkflowSandboxResult,
} from "#shared/workflow-sandbox.js";
import { CODE_MODE_BRIDGE_REQUEST_LIMIT } from "#harness/code-mode.js";
import { CODE_MODE_CALL_INTERRUPT_KIND } from "#execution/code-mode/program-step.js";

const security = { signingKey: "code-mode-program-step-test" };

/**
 * Pins the sandbox contract `runCodeModeProgramStep` relies on: calls issued
 * together park together, resolutions are applied by position without
 * re-running the program, and the program observes every value once the last
 * resolution lands. If `@ai-sdk/code-mode` changes this, the body's batch
 * settle would silently serialize or misroute, so this test fails first.
 */
describe("code-mode sandbox continuation contract", () => {
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
      bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
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
        bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
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
      bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
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
        bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
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
      bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
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
        bridgeRequestLimit: CODE_MODE_BRIDGE_REQUEST_LIMIT,
        continuationSecurity: security,
        interrupt: getWorkflowSandboxPendingInterrupts(first.interrupt)[0]!,
        resolution: 1,
        tools: { a: stub("a"), extra: stub("extra") } as ToolSet,
      }),
    ).rejects.toThrow(/tool names do not match/u);
  });
});
