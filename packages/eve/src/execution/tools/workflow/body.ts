import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessions } from "#execution/agent-sessions/session.js";
import type { WorkflowTaskContext, WorkflowToolContext } from "#tools/workflow-definition.js";
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
import type { WorkflowToolRunEntry } from "#shared/action-types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

export interface WorkflowBodyDefinition {
  /** Everything the run needs to open `ctx.agent` sessions for its caller. */
  readonly agentContext: AgentSessionContext;
  /** Snapshot added for new runs; absent only when resuming an older durable payload. */
  readonly agents?: WorkflowToolContext["agents"];
  readonly callId: string;
  /** The entry point the run invokes, which decides the body's context. */
  readonly entry: WorkflowToolRunEntry;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;

  readonly session: SessionContext["session"];
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowBodyInput extends WorkflowBodyDefinition {
  readonly owner: WorkflowToolRunOwner;
}

export interface WorkflowBodyResult {
  readonly outcome: WorkflowToolRunOutcome;
  /** Progress reports the body sent; the run relays each before the outcome. */
  readonly reportCount: number;
}

/**
 * What the run owns and lends its body: the call's signals, which commands on
 * the run's control hook abort, and the `ctx.agent` sessions the run ends when
 * it finishes.
 */
export interface WorkflowBodyRun {
  readonly abortSignal: AbortSignal;
  readonly agentSessions: AgentSessions;
  readonly interruptSignal: AbortSignal;
}

type WorkflowBodyContext = ToolContext & (WorkflowToolContext | WorkflowTaskContext);

type WorkflowEntryPointFunction = (
  input: unknown,
  ctx: WorkflowBodyContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/** Executes one registered workflow body and reports progress to its owner. */
export async function executeWorkflowBody(
  input: WorkflowBodyInput & { readonly runId?: string },
  run: WorkflowBodyRun,
): Promise<WorkflowBodyResult> {
  const signal = run.abortSignal;
  const from = createWorkflowBodyRef(input);
  const ctx = createWorkflowBodyContext(input, run);
  attachWorkflowToolRunContext(ctx, {
    // A caller that can't reach a person resolves `ctx.ask()` as `unavailable`.
    canRequestInput: input.agentContext.capabilities?.requestInput === true,
    from,
    owner: input.owner,
  });
  let reportCount = 0;

  try {
    const entryPoint = resolveWorkflowEntryPoint(input);
    const result = entryPoint(input.executeInput ?? input.input, ctx);
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
      output = (next.value as JsonValue | undefined) ?? last ?? null;
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
  input: WorkflowBodyDefinition & { readonly runId?: string },
): WorkflowToolRunRef {
  const ref: WorkflowToolRunRef = {
    callId: input.callId,
    input: input.input,
    runId: input.runId ?? getWorkflowMetadata().workflowRunId,
    sequence: input.session.turn.sequence,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    turnId: input.session.turn.id,
  };
  return input.entry.entryPoint === "task" ? { ...ref, taskId: input.entry.taskId } : ref;
}

function resolveWorkflowEntryPoint(input: WorkflowBodyInput): WorkflowEntryPointFunction {
  const entryPoint = readRegisteredWorkflow(input.workflowId);
  if (typeof entryPoint !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). The tool was renamed or removed after this run started.`,
    );
  }
  return entryPoint as WorkflowEntryPointFunction;
}

/**
 * The context the entry point gets: a task's, or, for an `execute` call the
 * turn waits on, the same plus `interruptSignal`.
 */
function createWorkflowBodyContext(
  input: WorkflowBodyInput,
  run: WorkflowBodyRun,
): WorkflowBodyContext {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  const ctx: ToolContext & WorkflowTaskContext = {
    agent: (name) => run.agentSessions.open(name),
    agents: Object.freeze(
      Object.fromEntries(
        Object.entries(input.agents ?? {}).map(([name, metadata]) => [
          name,
          Object.freeze({ ...metadata }),
        ]),
      ),
    ),
    ask: (request, options) => ask(ctx, request, options),
    abortSignal: run.abortSignal,
    callId: input.callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
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
  switch (input.entry.entryPoint) {
    case "execute":
      return Object.assign(ctx, { interruptSignal: run.interruptSignal });
    case "task":
      return ctx;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}
