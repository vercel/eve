import { jsonSchema, type ToolSet } from "ai";

import {
  DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND,
  readDynamicWorkflowCallInterrupt,
  type DynamicWorkflowCallInterrupt,
  type DynamicWorkflowInput,
} from "#execution/dynamic-workflow/schema.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import {
  continueWorkflowSandboxInterrupt,
  createParkingHostTool,
  createWorkflowSandboxTool,
  getWorkflowSandboxPendingInterrupts,
  unwrapWorkflowSandboxResult,
  type WorkflowSandboxContinuationSecurity,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";

export type DynamicWorkflowProgramOutcome =
  | { readonly output: JsonValue; readonly status: "completed" }
  | {
      readonly interrupt: WorkflowSandboxInterrupt;
      readonly pending: readonly WorkflowSandboxInterrupt[];
      readonly status: "interrupted";
    };

interface DynamicWorkflowProgramInput {
  readonly callId: string;
  readonly program: DynamicWorkflowInput;
  readonly resume?: {
    readonly interrupt: WorkflowSandboxInterrupt;
    readonly resolutions: readonly unknown[];
  };
}

/** Runs or resumes the side-effect-free JavaScript sandbox for one durable workflow. */
export async function runDynamicWorkflowProgramStep(
  input: DynamicWorkflowProgramInput,
): Promise<DynamicWorkflowProgramOutcome> {
  "use step";

  const tools = buildDynamicWorkflowProgramTools(input.program);
  const security = input.program.continuationSecurity as WorkflowSandboxContinuationSecurity;
  const bridgeRequestLimit = dynamicWorkflowBridgeRequestLimit(input.program.maxSubagents);
  let raw: unknown;
  if (input.resume === undefined) {
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit,
      continuationSecurity: security,
      hostTools: tools,
    });
    if (tool.execute === undefined) throw new Error("workflow has no sandbox executor.");
    raw = await tool.execute(
      { js: input.program.js } as never,
      {
        toolCallId: input.callId,
      } as never,
    );
  } else {
    let current = input.resume.interrupt;
    raw = current;
    for (const resolution of input.resume.resolutions) {
      raw = await continueWorkflowSandboxInterrupt({
        bridgeRequestLimit,
        continuationSecurity: security,
        interrupt: current,
        resolution,
        tools,
      });
      const unwrapped = await unwrapWorkflowSandboxResult(raw, security);
      if (unwrapped.status === "completed") break;
      const next = getWorkflowSandboxPendingInterrupts(unwrapped.interrupt)[0];
      if (next === undefined) {
        throw new Error("workflow continuation contains no pending agent call.");
      }
      current = next;
    }
  }

  const unwrapped = await unwrapWorkflowSandboxResult(raw, security);
  if (unwrapped.status === "completed") {
    return { output: parseJsonValue(unwrapped.output ?? null), status: "completed" };
  }
  const pending = getWorkflowSandboxPendingInterrupts(unwrapped.interrupt);
  if (pending.length === 0) {
    throw new Error("workflow continuation contains no pending agent call.");
  }
  for (const interrupt of pending) readDynamicWorkflowCallInterrupt(interrupt);
  return { interrupt: pending[0]!, pending, status: "interrupted" };
}

export function dynamicWorkflowBridgeRequestLimit(maxSubagents: number): number {
  return Math.max(256, maxSubagents + 1);
}

function buildDynamicWorkflowProgramTools(program: DynamicWorkflowInput): ToolSet {
  const tools: Record<string, ToolSet[string]> = {};
  for (const agent of program.agents) {
    tools[agent.name] = createParkingHostTool({
      description: agent.description,
      inputSchema: jsonSchema(agent.inputSchema),
      outputSchema: agent.outputSchema === null ? undefined : jsonSchema(agent.outputSchema),
      interrupt: (toolInput) =>
        ({
          kind: DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND,
          task: undefined,
          toolInput,
          toolName: agent.name,
        }) satisfies DynamicWorkflowCallInterrupt,
    });
  }
  return tools as ToolSet;
}
