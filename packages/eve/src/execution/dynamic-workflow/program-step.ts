import { jsonSchema, type ToolSet } from "ai";

import { FatalError } from "#compiled/@workflow/core/index.js";
import {
  WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND,
  parseWorkflowProgramOutput,
  readWorkflowProgramCallInterrupt,
  type WorkflowProgramCallInterrupt,
  type WorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  continueWorkflowSandboxInterrupt,
  createParkingHostTool,
  createWorkflowSandboxTool,
  getWorkflowSandboxPendingInterrupts,
  unwrapWorkflowSandboxResult,
  type WorkflowSandboxContinuationSecurity,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";

export type WorkflowProgramStepOutcome =
  | { readonly output: ReturnType<typeof parseWorkflowProgramOutput>; readonly status: "completed" }
  | {
      readonly interrupt: WorkflowSandboxInterrupt;
      readonly pending: readonly WorkflowSandboxInterrupt[];
      readonly status: "interrupted";
    };

interface WorkflowProgramStepInput {
  readonly callId: string;
  readonly program: WorkflowProgramInput;
  readonly resume?: {
    readonly interrupt: WorkflowSandboxInterrupt;
    readonly resolutions: readonly unknown[];
  };
}

const agentBridgeSchema = jsonSchema({
  additionalProperties: false,
  properties: {
    input: {
      additionalProperties: false,
      properties: {
        message: { type: "string" },
        outputSchema: { type: "object" },
      },
      required: ["message"],
      type: "object",
    },
    target: { type: "string" },
  },
  required: ["target", "input"],
  type: "object",
});

/** Runs or resumes the side-effect-free JavaScript sandbox for one durable workflow. */
export async function runWorkflowProgramStep(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  "use step";

  try {
    return await runWorkflowProgram(input);
  } catch (error) {
    // The sandbox is deterministic, so a failed program fails the same way on every retry.
    throw new FatalError(toErrorMessage(error));
  }
}

async function runWorkflowProgram(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  const tools = buildWorkflowProgramTools();
  const security = input.program.continuationSecurity as WorkflowSandboxContinuationSecurity;
  let raw: unknown;
  if (input.resume === undefined) {
    const tool = await createWorkflowSandboxTool({
      bridgeRequestLimit: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
      continuationSecurity: security,
      hostTools: tools,
    });
    if (tool.execute === undefined) throw new Error("Workflow program has no sandbox executor.");
    raw = await tool.execute(
      { js: wrapWorkflowProgram(input.program.js) } as never,
      { toolCallId: input.callId } as never,
    );
  } else {
    let current = input.resume.interrupt;
    raw = current;
    for (const resolution of input.resume.resolutions) {
      raw = await continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
        continuationSecurity: security,
        interrupt: current,
        resolution,
        tools,
      });
      const unwrapped = await unwrapWorkflowSandboxResult(raw, security);
      if (unwrapped.status === "completed") break;
      const next = getWorkflowSandboxPendingInterrupts(unwrapped.interrupt)[0];
      if (next === undefined) {
        throw new Error("Workflow program continuation contains no pending agent call.");
      }
      current = next;
    }
  }

  const unwrapped = await unwrapWorkflowSandboxResult(raw, security);
  if (unwrapped.status === "completed") {
    return { output: parseWorkflowProgramOutput(unwrapped.output), status: "completed" };
  }
  const pending = getWorkflowSandboxPendingInterrupts(unwrapped.interrupt);
  if (pending.length === 0) {
    throw new Error("Workflow program continuation contains no pending agent call.");
  }
  for (const interrupt of pending) readWorkflowProgramCallInterrupt(interrupt);
  return { interrupt: pending[0]!, pending, status: "interrupted" };
}

function buildWorkflowProgramTools(): ToolSet {
  return {
    agent: createParkingHostTool({
      description: "Invoke one allowlisted child agent.",
      inputSchema: agentBridgeSchema,
      interrupt: (toolInput) =>
        ({
          kind: WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND,
          task: undefined,
          toolInput,
          toolName: "agent",
        }) satisfies WorkflowProgramCallInterrupt,
    }),
  } as ToolSet;
}

function wrapWorkflowProgram(source: string): string {
  return `return await (async (ctx) => {\n${source}\n})(Object.freeze({\n  agent: (target, input) => tools.agent({ target, input }),\n}));`;
}
