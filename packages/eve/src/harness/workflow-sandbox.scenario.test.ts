import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { getWorkflowRuntimeActionInterrupts } from "#harness/workflow-runtime-action-state.js";
import { applyWorkflowTool } from "#harness/workflow-sandbox.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import {
  continueWorkflowSandboxInterrupt,
  getWorkflowSandboxInterrupt,
  type WorkflowSandboxLifecycle,
  unwrapWorkflowSandboxResult,
} from "#shared/workflow-sandbox.js";

function orchestrationTools(): HarnessToolMap {
  return new Map<string, HarnessToolDefinition>([
    [
      "echo-marker",
      {
        description: "Echo one marker.",
        inputSchema: jsonSchema({
          properties: { message: { type: "string" } },
          required: ["message"],
          type: "object",
        }),
        name: "echo-marker",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/echo-marker",
          subagentName: "echo-marker",
        },
      },
    ],
  ]);
}

const concurrentProgram = `return await Promise.all([
  tools["echo-marker"]({ message: "alpha" }),
  tools["echo-marker"]({ message: "beta" }),
]);`;
const continuationSecurity = {
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
  signingKey: "workflow-sandbox-scenario-test-key",
};

describe("Workflow concurrent continuation", () => {
  it("collects promptly interrupted Promise.all siblings in one ledger", async () => {
    const tools = orchestrationTools();
    const { modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools: tools,
      tools: buildToolSet({ tools }),
    });
    const execute = modelTools.Workflow?.execute as
      | ((input: { js: string }, options: { messages: []; toolCallId: string }) => Promise<unknown>)
      | undefined;

    const initialOutput = await execute!(
      { js: concurrentProgram },
      { messages: [], toolCallId: "workflow-call" },
    );
    const interrupt = await getWorkflowSandboxInterrupt(initialOutput, continuationSecurity);

    expect(interrupt!.continuation.auth.expiresAtMs - interrupt!.continuation.auth.issuedAtMs).toBe(
      continuationSecurity.maxAgeMs,
    );
    expect(getWorkflowRuntimeActionInterrupts(interrupt!).map((entry) => entry.input)).toEqual([
      { message: "alpha" },
      { message: "beta" },
    ]);
  });

  it("preserves and resolves sibling interrupts when a later call interrupts first", async () => {
    const tools = orchestrationTools();
    const lifecycle: WorkflowSandboxLifecycle = {
      async onNestedToolCall(event) {
        if ((event.input as { message?: string }).message === "alpha") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
    };
    const { hostTools, modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools: tools,
      lifecycle,
      tools: buildToolSet({ tools }),
    });
    const execute = modelTools.Workflow?.execute as
      | ((input: { js: string }, options: { messages: []; toolCallId: string }) => Promise<unknown>)
      | undefined;
    expect(execute).toBeDefined();

    const initialOutput = await execute!(
      { js: concurrentProgram },
      { messages: [], toolCallId: "workflow-call" },
    );
    const racedInterrupt = await getWorkflowSandboxInterrupt(initialOutput, continuationSecurity);
    expect(racedInterrupt?.input).toEqual({ message: "beta" });

    const pending = getWorkflowRuntimeActionInterrupts(racedInterrupt!);
    expect(pending.map((interrupt) => interrupt.input)).toEqual([
      { message: "alpha" },
      { message: "beta" },
    ]);

    const firstContinuation = await continueWorkflowSandboxInterrupt({
      continuationSecurity,
      interrupt: pending[0]!,
      lifecycle,
      resolution: "alpha-result",
      tools: hostTools,
    });
    const firstUnwrapped = await unwrapWorkflowSandboxResult(
      firstContinuation,
      continuationSecurity,
    );
    expect(firstUnwrapped).toMatchObject({
      interrupt: { input: { message: "beta" } },
      status: "interrupted",
    });
    if (firstUnwrapped.status !== "interrupted") throw new Error("Expected second interrupt.");

    const finalContinuation = await continueWorkflowSandboxInterrupt({
      continuationSecurity,
      interrupt: firstUnwrapped.interrupt,
      lifecycle,
      resolution: "beta-result",
      tools: hostTools,
    });
    await expect(
      unwrapWorkflowSandboxResult(finalContinuation, continuationSecurity),
    ).resolves.toEqual({
      output: ["alpha-result", "beta-result"],
      status: "completed",
    });
  });
});
