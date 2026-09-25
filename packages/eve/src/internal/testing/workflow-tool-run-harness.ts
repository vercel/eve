import { type TestRuntime, createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { serializeInputSchema, toInputSchema } from "#tools/schema.js";
import { getRun } from "#internal/workflow/runtime.js";
import {
  type BlockingWorkflowToolDefinition,
  defineWorkflowTool,
} from "#tools/workflow-definition.js";

const DEPLOY_INPUT_SCHEMA = toInputSchema({
  additionalProperties: false,
  properties: { service: { type: "string" } },
  required: ["service"],
  type: "object",
});

export function buildWorkflowToolSerializedContext(input: {
  readonly acceptedDeploymentId?: string;
  readonly continuationToken: string;
  readonly mode: "conversation" | "task";
  readonly requestInput?: boolean;
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.capabilities": { requestInput: input.requestInput ?? false },
    "eve.channel": { kind: "http", state: {} },
    ...(input.acceptedDeploymentId === undefined
      ? {}
      : {
          "eve.channelDelivery": {
            acceptedDeploymentId: input.acceptedDeploymentId,
            channelKind: "http",
            channelName: "test",
            deliveryId: "delivery-initial",
          },
        }),
    "eve.continuationToken": input.continuationToken,
    "eve.mode": input.mode,
  };
}

/**
 * Registers one fixture workflow as an authored tool. The fixture module
 * passed through the test tier's client transform, so `execute` is the stub
 * the real pipeline produces: a function carrying its `workflowId`.
 */
export async function createWorkflowToolRuntime(input: {
  readonly agentName: string;
  readonly background?: boolean;
  readonly execute: (...args: never[]) => unknown;
  readonly inputSchema?: ResolvedToolDefinition["inputSchema"];
  readonly toolName: string;
}): Promise<TestRuntime> {
  return await createTestRuntime({
    agent: { name: input.agentName },
    modules: [
      {
        logicalPath: `tools/${input.toolName}.ts`,
        loadNamespace: async () => ({
          default: defineWorkflowTool({
            execution: input.background === true ? "background" : undefined,
            description: `Deploys a service (${input.toolName}).`,
            execute: input.execute as BlockingWorkflowToolDefinition["execute"],
            inputSchema: serializeInputSchema(input.inputSchema ?? DEPLOY_INPUT_SCHEMA) ?? {},
          }),
        }),
      },
    ],
  });
}

/** Polls one run until it reaches a terminal status, returning that status. */
export async function waitForWorkflowToolRunTerminal(
  runId: string,
  timeout = 15_000,
): Promise<string> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await getRun(runId).status;
    if (terminal.has(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach a terminal status.`);
}
