import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createAgentSessions } from "#execution/agent-sessions/session.js";
import type { AgentSession, WorkflowToolContext } from "#tools/workflow-definition.js";
import {
  ask,
  attachWorkflowToolRunContext,
  type WorkflowToolRunAsks,
} from "#execution/tools/workflow/ask.js";
import type {
  WorkflowToolRunOutcome,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

export interface WorkflowBodyDefinition {
  /** Everything the run needs to open `ctx.agent` sessions for its caller. */
  readonly agentContext: AgentSessionContext;
  /** Snapshot added for new runs; absent only when resuming an older durable payload. */
  readonly agents?: WorkflowToolContext["agents"];
  readonly callId: string;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;

  readonly session: SessionContext["session"];
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowBodyInput extends WorkflowBodyDefinition {
  /** The run's control hook, which the session answers the body's questions on. */
  readonly hookToken: string;
  readonly owner: WorkflowToolRunInbox;
}

/** The call's signals, which commands on the run's control hook abort. */
export interface WorkflowBodyRun {
  readonly abortSignal: AbortSignal;
  readonly interruptSignal: AbortSignal;
}

/** A body the run started. */
export interface StartedWorkflowBody {
  /** Releases what the body opened, such as its `ctx.agent` sessions, once the run ends. */
  close(): Promise<void>;
  readonly outcome: Promise<WorkflowToolRunOutcome>;
}

type WorkflowToolExecute = (
  input: unknown,
  ctx: WorkflowToolContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/** Starts one registered workflow body, which reports progress to its owner. */
export function startWorkflowBody(
  input: WorkflowBodyInput & { readonly runId?: string },
  run: WorkflowBodyRun,
  asks: WorkflowToolRunAsks,
): StartedWorkflowBody {
  const runContext = {
    agentContext: input.agentContext,
    asks,
    control: input.hookToken,
    from: createWorkflowBodyRef(input),
    owner: input.owner,
  };
  const agentSessions = createAgentSessions(runContext);
  const ctx = createWorkflowBodyContext(input, run, agentSessions.open);
  attachWorkflowToolRunContext(ctx, runContext);
  return {
    close: agentSessions.close,
    outcome: executeWorkflowBody(input, ctx, runContext.from),
  };
}

async function executeWorkflowBody(
  input: WorkflowBodyInput,
  ctx: ToolContext & WorkflowToolContext,
  from: WorkflowToolRunRef,
): Promise<WorkflowToolRunOutcome> {
  const signal = ctx.abortSignal;
  try {
    const execute = resolveWorkflowToolExecute(input);
    const result = execute(input.executeInput ?? input.input, ctx);
    let output: JsonValue;
    if (!isAsyncIterable(result)) {
      output = await result;
    } else {
      const iterator = result[Symbol.asyncIterator]();
      let last: JsonValue | undefined;
      let next = await iterator.next();
      while (next.done !== true) {
        last = next.value;
        await input.owner.send({ from, kind: "report", update: next.value });
        next = await iterator.next();
      }
      output = (next.value as JsonValue | undefined) ?? last ?? null;
    }
    return { output, status: "completed" };
  } catch (error) {
    if (signal.aborted) {
      return {
        reason:
          signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
        status: "cancelled",
      };
    }
    return { error: normalizeSerializableError(error), status: "failed" };
  }
}

export function createWorkflowBodyRef(
  input: WorkflowBodyDefinition & { readonly runId?: string },
): WorkflowToolRunRef {
  return {
    callId: input.callId,
    input: input.input,
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
  run: WorkflowBodyRun,
  agent: (name: string) => AgentSession,
): ToolContext & WorkflowToolContext {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  const ctx: ToolContext & WorkflowToolContext = {
    agent,
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
    interruptSignal: run.interruptSignal,
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
  return ctx;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}
