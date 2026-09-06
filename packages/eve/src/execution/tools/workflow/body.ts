import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { SessionContext } from "#context/session-context.js";
import { agent } from "#execution/tools/subagent/invoke-agent.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import {
  type WorkflowToolRunOutcome,
  type WorkflowToolRunOwner,
  type WorkflowToolRunRef,
  type WorkflowToolRunReport,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";
import { createTaskMessage, type TaskExec } from "#tools/task.js";

export interface WorkflowBodyDefinition {
  readonly callId: string;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;
  readonly resultKind?: "subagent" | "tool";
  readonly session: SessionContext["session"];
  readonly stepIndex: number;
  readonly taskId?: string;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowBodyInput extends WorkflowBodyDefinition {
  readonly owner: WorkflowToolRunOwner;
}

export interface WorkflowBodyResult {
  readonly outcome: WorkflowToolRunOutcome;
  readonly reportCount: number;
}

type WorkflowToolExecute = (
  input: unknown,
  ctx: WorkflowToolContext,
  task?: TaskExec,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/** Executes one registered workflow body and reports progress to its owner. */
export async function executeWorkflowBody(
  input: WorkflowBodyInput & {
    readonly execution: "background" | "blocking";
    readonly runId?: string;
  },
  signal: AbortSignal,
): Promise<WorkflowBodyResult> {
  const from = createWorkflowBodyRef(input);
  const ctx = createWorkflowBodyContext(input, signal);
  attachWorkflowToolRunContext(ctx, { from, owner: input.owner });
  let reportCount = 0;

  try {
    const execute = resolveWorkflowToolExecute(input);
    const task = input.execution === "background" ? createWorkflowTaskExec(input) : undefined;
    const result = execute(input.executeInput ?? input.input, ctx, task);
    let output: JsonValue;
    if (!isAsyncIterable(result)) {
      output = await result;
    } else {
      const iterator = result[Symbol.asyncIterator]();
      let last: JsonValue | undefined;
      let next = await iterator.next();
      while (next.done !== true) {
        last = next.value;
        const report: WorkflowToolRunReport = { from, update: next.value };
        await resumeHookStep(input.owner.inbox, { kind: "report", ...report });
        reportCount += 1;
        next = await iterator.next();
      }
      output =
        (next.value as JsonValue | undefined) ??
        (input.execution === "blocking" ? last : undefined) ??
        null;
    }
    return { outcome: { output, status: "completed" }, reportCount };
  } catch (error) {
    if (signal.aborted) {
      return {
        outcome: {
          reason:
            signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
          status: "cancelled",
        },
        reportCount,
      };
    }
    return { outcome: { error: normalizeSerializableError(error), status: "failed" }, reportCount };
  }
}

export function createWorkflowBodyRef(
  input: WorkflowBodyDefinition & {
    readonly execution: "background" | "blocking";
    readonly runId?: string;
  },
): WorkflowToolRunRef {
  return {
    callId: input.callId,
    execution: input.execution,
    input: input.input,
    resultKind: input.resultKind,
    runId: input.runId ?? getWorkflowMetadata().workflowRunId,
    sequence: input.session.turn.sequence,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    turnId: input.session.turn.id,
  };
}

function resolveWorkflowToolExecute(input: WorkflowBodyInput): WorkflowToolExecute {
  const execute = readRegisteredWorkflow(input.workflowId);
  if (typeof execute !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). The tool was renamed or removed after this run started.`,
    );
  }
  return execute as WorkflowToolExecute;
}

function createWorkflowBodyContext(
  input: WorkflowBodyInput,
  signal: AbortSignal,
): ToolContext & WorkflowToolContext {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  const ctx: ToolContext & WorkflowToolContext = {
    agent: (input) => agent(ctx, input),
    ask: (request) => ask(ctx, request),
    abortSignal: signal,
    callId: input.callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getSkill: () => unavailable("getSkill()", "skills are read through the session sandbox"),
    getToken: () =>
      unavailable("getToken()", 'pass ctx directly to a "use step" helper to resolve credentials'),
    requireAuth: () =>
      unavailable(
        "requireAuth()",
        'pass ctx directly to a "use step" helper to request authorization',
      ),
    session: input.session,
    toolName: input.toolName,
  };
  return ctx;
}

function createWorkflowTaskExec(input: WorkflowBodyInput): TaskExec {
  if (input.taskId === undefined) {
    throw new Error(`Background workflow tool "${input.toolName}" has no task id.`);
  }
  return {
    binding: { taskId: input.taskId, token: input.taskId },
    postMessage: createTaskMessage,
    send() {
      throw new Error("task.send() was replaced by yielded task descriptors.");
    },
    session: undefined as never,
    task: undefined as never,
    taskId: input.taskId,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}
