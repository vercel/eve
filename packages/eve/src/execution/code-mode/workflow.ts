import type { InputOption } from "#shared/input.js";
import type { ToolContext, ToolInputRequest } from "#tools/definition.js";
import { ASK_QUESTION_TOOL_NAME } from "#harness/request-input-tool.js";
import { invokeAgent } from "#execution/tools/subagent/invoke-agent.js";
import {
  ask,
  requestInput,
  readCodeModeRunContext,
  readWorkflowToolRunOwner,
  readWorkflowToolRunRef,
} from "#execution/tools/workflow/ask.js";
import { executeWorkflowBody } from "#execution/tools/workflow/body.js";
import { parseCodeModeWorkflowInput } from "#execution/code-mode/schema.js";
import type { CodeModeCallResolution, CodeModeWorkflowInput } from "#execution/code-mode/schema.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import {
  evaluateCodeModeApprovalStep,
  executeCodeModeToolStep,
  runCodeModeProgramStep,
  type CodeModeCallInterrupt,
  type CodeModePendingCall,
  type CodeModeProgramOutcome,
  type CodeModeToolCall,
} from "#execution/code-mode/program-step.js";
import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  adoptCodeModeStateChanges,
  approvedToolStateChange,
  type CodeModeStateChange,
} from "#execution/code-mode/state.js";

/**
 * Durable body behind the framework `code_mode` tool.
 *
 * The generated program runs in a sandbox that parks at every nested call.
 * Ordinary tools execute in a child-owned step over the turn's serialized
 * context; subagents go through the owner's `agent-invoke` channel like any
 * workflow tool, so the parent keeps sole ownership of agent handles and
 * session state; authored workflow tools run their body inline, nesting its
 * steps into this run. Approval-gated tools ask the person first through the
 * workflow-tool `ask` protocol. Each nested call therefore has its own replay
 * boundary.
 */
export async function codeModeWorkflow(
  rawInput: unknown,
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "session" | "toolName">,
): Promise<JsonValue> {
  "use workflow";

  const program = parseCodeModeWorkflowInput(rawInput);
  const run = readCodeModeRunContext(ctx);
  const base = {
    callId: ctx.callId,
    program,
    sessionState: run.sessionState,
  };
  let outcome: CodeModeProgramOutcome = await runCodeModeProgramStep(base);
  let nested = 0;
  let subagentCalls = 0;
  while (outcome.status === "interrupted") {
    if (ctx.abortSignal.aborted) {
      throw ctx.abortSignal.reason ?? new Error("code_mode was cancelled.");
    }
    // Calls parked together were issued together (Promise.all); settle them
    // together. Ids are assigned before the await so replay hands each call
    // the same id regardless of completion order.
    const settling = outcome.pending.map((pending): Promise<SettledNestedCall> => {
      if (pending.call.target === "agent" && subagentCalls++ >= program.maxSubagents) {
        return Promise.resolve({
          resolution: {
            status: "failed" as const,
            error: `CODE_MODE_SUBAGENT_LIMIT_REACHED: code_mode may invoke at most ${program.maxSubagents} subagents per program; "${pending.call.toolName}" was not called.`,
          },
        });
      }
      const invocationId = `${ctx.callId}:${String(nested++)}`;
      return settleNestedCall(ctx, run, program, pending, invocationId);
    });
    const settled = await Promise.all(settling);
    // Adopt state in pending order once the batch settles, so replay applies
    // the same merges (and surfaces the same conflicts) regardless of which
    // call finished first.
    const resolutions = settled.map(({ resolution, stateChanges }): CodeModeCallResolution => {
      if (stateChanges === undefined || stateChanges.length === 0) return resolution;
      try {
        const updated = adoptCodeModeStateChanges(run, stateChanges);
        run.serializedContext = updated.serializedContext;
        run.sessionState = updated.sessionState;
        return resolution;
      } catch (error) {
        return { status: "failed", error: toErrorMessage(error) };
      }
    });
    outcome = await runCodeModeProgramStep({
      ...base,
      resume: { interrupt: outcome.interrupt, resolutions },
    });
  }
  if (outcome.status === "failed") throw new Error(outcome.error);
  return outcome.output;
}

interface SettledNestedCall {
  readonly resolution: CodeModeCallResolution;
  readonly stateChanges?: readonly CodeModeStateChange[];
}

async function settleNestedCall(
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "session" | "toolName">,
  run: ReturnType<typeof readCodeModeRunContext>,
  program: CodeModeWorkflowInput,
  pending: CodeModePendingCall,
  invocationId: string,
): Promise<SettledNestedCall> {
  const { call, toolCallId } = pending;
  const from = readWorkflowToolRunRef(ctx);
  const { sequence, stepIndex, turnId } = from;
  try {
    const nestedCall: CodeModeToolCall = {
      event: { sequence, stepIndex, turnId },
      serializedContext: run.serializedContext,
      sessionState: run.sessionState,
      toolCallId,
      toolInput: call.toolInput,
      toolName: call.toolName,
    };
    const approval = await approveNestedCall(ctx, program, nestedCall);
    if (approval.status === "denied") return { resolution: approval.resolution };
    if (call.target === "workflow") {
      const resolution = await runNestedWorkflowTool(ctx, from, program, call);
      return { resolution, stateChanges: approval.stateChanges };
    }
    if (call.target === "agent") {
      const agentInput = readAgentInput(call.toolInput);
      const output = await invokeAgent(
        ctx,
        { ...agentInput, target: call.toolName },
        { invocationId },
      );
      return { resolution: { status: "completed", output } };
    }
    if (call.toolName === ASK_QUESTION_TOOL_NAME) {
      // Answered through the workflow-tool `ask` protocol: the owner renders the
      // question on the session channel and the program waits for the answer.
      const answer = await ask(ctx, readAskInput(call.toolInput));
      const output: Record<string, string> = { status: "answered" };
      if (answer.optionId !== undefined) output.optionId = answer.optionId;
      if (answer.text !== undefined) output.text = answer.text;
      return { resolution: { status: "completed", output } };
    }
    // Passing `ctx` opts this step into the workflow-tool authorization twin,
    // which parks on sign-in and retries the step; the body only sees results.
    const settled = await executeCodeModeToolStep(ctx, nestedCall);
    // The authorization twin never lets a signal reach the body; a bare signal
    // means this step ran without its twin. (Structural check: the harness
    // module is not importable from the workflow driver body.)
    if (!("status" in settled)) {
      throw new Error(`Tool "${call.toolName}" requested authorization outside a workflow step.`);
    }
    const { stateChanges, ...resolution } = settled;
    return {
      resolution,
      stateChanges: [...(approval.stateChanges ?? []), ...(stateChanges ?? [])],
    };
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    return { resolution: { status: "failed", error: toErrorMessage(error) } };
  }
}

type NestedCallApproval =
  | { readonly status: "approved"; readonly stateChanges?: readonly CodeModeStateChange[] }
  | { readonly status: "denied"; readonly resolution: CodeModeCallResolution };

/**
 * Asks the person before an approval-gated nested call, the way the harness
 * would before a direct call. The approval renders as a tool-approval card for
 * the nested tool; a granted approval is recorded as a state change so `once()`
 * holds for later calls in this program and for the parent session afterwards.
 */
async function approveNestedCall(
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "session" | "toolName">,
  program: CodeModeWorkflowInput,
  nestedCall: CodeModeToolCall,
): Promise<NestedCallApproval> {
  const entry = program.toolCatalog.find((candidate) => candidate.name === nestedCall.toolName);
  if (entry?.approval !== true) return { status: "approved" };
  const decision = await evaluateCodeModeApprovalStep(nestedCall);
  switch (decision.status) {
    case "not-required":
      return { status: "approved" };
    case "failed":
      return { status: "denied", resolution: decision };
    case "denied":
      return {
        status: "denied",
        resolution: approvalDenied("the approval policy", nestedCall.toolName, decision.reason),
      };
    case "required": {
      // The answer routes back by request id; `action` only attributes the
      // card to the nested call so channels render it as a tool approval.
      const answer = await requestInput(ctx, (requestId) => ({
        ...decision.request,
        action: { ...decision.action, kind: "tool-call" },
        kind: "tool-approval",
        options: decision.request.options === undefined ? undefined : [...decision.request.options],
        requestId,
      }));
      if (answer.optionId !== "approve") {
        return { status: "denied", resolution: approvalDenied("the user", nestedCall.toolName) };
      }
      return { status: "approved", stateChanges: [approvedToolStateChange(decision.approvalKey)] };
    }
  }
}

function approvalDenied(by: string, toolName: string, reason?: string): CodeModeCallResolution {
  const detail = reason === undefined ? "" : ` ${reason}`;
  return {
    status: "failed",
    error: `CODE_MODE_APPROVAL_DENIED: ${by} declined to run "${toolName}".${detail}`,
  };
}

/**
 * Runs an authored workflow tool's body inline, so its steps nest into this
 * run. The nested body reports under this run's own `callId`/`runId`: the
 * owner routes `ask`, `agent-invoke`, authorization, and progress messages
 * by that pair, so they are attributed to the `code_mode` call.
 */
async function runNestedWorkflowTool(
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "session" | "toolName">,
  from: WorkflowToolRunRef,
  program: CodeModeWorkflowInput,
  call: CodeModeCallInterrupt,
): Promise<CodeModeCallResolution> {
  const entry = program.toolCatalog.find((candidate) => candidate.name === call.toolName);
  if (entry?.target !== "workflow" || entry.workflowId === undefined) {
    throw new Error(`Tool "${call.toolName}" is not a workflow tool in this program's catalog.`);
  }
  const { outcome } = await executeWorkflowBody(
    {
      authorizationSupported: true,
      callId: from.callId,
      execution: "blocking",
      input: readWorkflowToolInput(call),
      owner: readWorkflowToolRunOwner(ctx),
      session: ctx.session,
      stepIndex: from.stepIndex,
      toolName: call.toolName,
      workflowId: entry.workflowId,
    },
    ctx.abortSignal,
  );
  if (outcome.status === "completed") return { status: "completed", output: outcome.output };
  if (outcome.status === "failed")
    return { status: "failed", error: toErrorMessage(outcome.error) };
  ctx.abortSignal.throwIfAborted();
  throw new Error(outcome.reason || `Workflow tool "${call.toolName}" was cancelled.`);
}

function readWorkflowToolInput(call: CodeModeCallInterrupt): JsonObject {
  try {
    return parseJsonObject(call.toolInput);
  } catch {
    throw new TypeError(`Workflow tool "${call.toolName}" requires a JSON object input.`);
  }
}

interface CodeModeAgentInput {
  agentId?: string;
  message: string;
  outputSchema?: JsonObject;
}

function readAgentInput(value: unknown): CodeModeAgentInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Subagent calls from code_mode require an object input.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string") {
    throw new TypeError('Subagent calls from code_mode require a "message" string.');
  }
  const input: CodeModeAgentInput = { message: record.message };
  if (typeof record.agentId === "string") input.agentId = record.agentId;
  if (typeof record.outputSchema === "object" && record.outputSchema !== null) {
    input.outputSchema = record.outputSchema as JsonObject;
  }
  return input;
}

function readAskInput(value: unknown): ToolInputRequest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("ask_question calls from code_mode require an object input.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.prompt !== "string" || record.prompt.length === 0) {
    throw new TypeError('ask_question calls from code_mode require a non-empty "prompt" string.');
  }
  const request: { -readonly [K in keyof ToolInputRequest]: ToolInputRequest[K] } = {
    prompt: record.prompt,
  };
  if (Array.isArray(record.options)) request.options = record.options as InputOption[];
  if (typeof record.allowFreeform === "boolean") request.allowFreeform = record.allowFreeform;
  return request;
}
