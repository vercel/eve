import { getWorkflowMetadata, sleep as workflowSleep } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  attachWorkflowToolRunContext,
  type WorkflowToolRunOutcome,
  type WorkflowToolRunOutcomeMessage,
  type WorkflowToolRunRef,
  type WorkflowToolRunReport,
} from "#execution/tools/workflow/messages.js";
import { openWorkflowToolRunControlInbox } from "#execution/tools/workflow/run-control.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

const CANCEL_GRACE = "30s";

type WorkflowToolExecute = (
  input: unknown,
  ctx: ToolContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/** Runs one authored workflow tool call and reports to its declared owner hooks. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const control = openWorkflowToolRunControlInbox(input.hookToken);
  let ownsInbox = false;
  try {
    try {
      await claimHookOwnership(control.hook);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    const from = createWorkflowToolRunRef(input);
    const ctx = createWorkflowToolContext(input, control.signal);
    attachWorkflowToolRunContext(ctx, { from, owner: input.owner });
    const body = executeWorkflowToolBody(input, ctx, from);
    const settled = body.catch(() => {});
    let outcome: WorkflowToolRunOutcome;
    try {
      outcome = { output: await Promise.race([body, control.cancelled]), status: "completed" };
    } catch (error) {
      if (!control.signal.aborted) {
        outcome = { error: normalizeSerializableError(error), status: "failed" };
      } else {
        await Promise.race([settled, workflowSleep(CANCEL_GRACE)]);
        outcome = { reason: control.reason(), status: "cancelled" };
      }
    }

    const message: WorkflowToolRunOutcomeMessage = { from, result: outcome };
    await resumeHookStep(input.owner.outcome, message, {
      ifPresent: outcome.status === "cancelled",
    });
  } finally {
    if (ownsInbox) await disposeHook(control.hook);
  }
}

async function executeWorkflowToolBody(
  input: WorkflowToolRunInput,
  ctx: ToolContext,
  from: WorkflowToolRunRef,
): Promise<JsonValue> {
  const execute = resolveWorkflowToolExecute(input);
  const result = execute(input.executeInput ?? input.input, ctx);
  if (!isAsyncIterable(result)) return await result;

  const iterator = result[Symbol.asyncIterator]();
  let last: JsonValue | undefined;
  let next = await iterator.next();
  while (next.done !== true) {
    last = next.value;
    const report: WorkflowToolRunReport = { from, update: next.value };
    await resumeHookStep(input.owner.report, report);
    next = await iterator.next();
  }
  return (next.value as JsonValue | undefined) ?? last ?? null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}

function createWorkflowToolRunRef(input: WorkflowToolRunInput): WorkflowToolRunRef {
  return {
    callId: input.callId,
    execution: input.execution ?? "blocking",
    input: input.input,
    resultKind: input.resultKind,
    runId: readWorkflowToolRunId(),
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    turnId: input.session.turn.id,
  };
}

function readWorkflowToolRunId(): string {
  const runId = getWorkflowMetadata().workflowRunId;
  if (typeof runId !== "string") throw new Error("The workflow tool run has no workflow run id.");
  return runId;
}

function resolveWorkflowToolExecute(input: WorkflowToolRunInput): WorkflowToolExecute {
  const execute = readRegisteredWorkflow(input.workflowId);
  if (typeof execute !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). The tool was renamed or removed after this run started.`,
    );
  }
  return execute as WorkflowToolExecute;
}

function createWorkflowToolContext(input: WorkflowToolRunInput, signal: AbortSignal): ToolContext {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  return {
    abortSignal: signal,
    callId: input.callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getSkill: () => unavailable("getSkill()", "skills are read through the session sandbox"),
    getToken: () =>
      unavailable("getToken()", 'read credentials from the environment inside a "use step" helper'),
    requireAuth: () => unavailable("requireAuth()", "a workflow body cannot park on authorization"),
    session: input.session,
    toolName: input.toolName,
  };
}
