import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessions } from "#execution/agent-sessions/session.js";
import type {
  WorkflowSharedContext,
  WorkflowTaskContext,
  WorkflowToolContext,
} from "#tools/workflow-definition.js";
import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import {
  type WorkflowToolRunControlMessage,
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
  readonly runId?: string;
}

export interface WorkflowBodyResult {
  readonly outcome: WorkflowToolRunOutcome;
  /** Reports and replies the body sent; the run relays each before the outcome. */
  readonly messageCount: number;
}

/**
 * How the session's commands reach a running body. What a command means
 * depends on the entry point: a cancel ends an `execute` or `task` call, but
 * only the current stretch of work of a `serve` task.
 */
export interface WorkflowBodyControl {
  /** Aborts when the run stops for good; the run then settles as cancelled. */
  readonly runSignal: AbortSignal;
  apply(command: WorkflowToolRunControlMessage): void;
}

/** A body the run started, and how its commands reach it. */
export interface StartedWorkflowBody {
  readonly control: WorkflowBodyControl;
  readonly result: Promise<WorkflowBodyResult>;
}

type WorkflowCallContext = ToolContext & (WorkflowToolContext | WorkflowTaskContext);

type WorkflowCallEntryPoint = (
  input: unknown,
  ctx: WorkflowCallContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/** The signals of an `execute` or `task` call, which the run's commands abort. */
class WorkflowCallSignals implements WorkflowBodyControl {
  private readonly abort = new AbortController();
  private readonly interrupt = new AbortController();

  get runSignal(): AbortSignal {
    return this.abort.signal;
  }

  get interruptSignal(): AbortSignal {
    return this.interrupt.signal;
  }

  apply(command: WorkflowToolRunControlMessage): void {
    switch (command.kind) {
      case "cancel":
      case "end":
        this.abort.abort(new WorkflowToolRunCancelledError(command.reason));
        return;
      case "interrupt":
        this.interrupt.abort();
        return;
      case "call":
        // Only a `serve` task takes later calls.
        return;
    }
  }
}

/** Starts the body of an `execute` or `task` call, which serves the call the run started with. */
export function startCallBody(
  input: WorkflowBodyInput,
  agentSessions: AgentSessions,
): StartedWorkflowBody {
  const signals = new WorkflowCallSignals();
  return { control: signals, result: executeCallBody(input, signals, agentSessions) };
}

/** Executes one call's registered workflow body and reports progress to its owner. */
async function executeCallBody(
  input: WorkflowBodyInput,
  signals: WorkflowCallSignals,
  agentSessions: AgentSessions,
): Promise<WorkflowBodyResult> {
  const from = createWorkflowBodyRef(input);
  const ctx = createCallContext(input, signals, agentSessions);
  attachWorkflowToolRunContext(ctx, {
    // A caller that can't reach a person resolves `ctx.ask()` as `unavailable`.
    canRequestInput: input.agentContext.capabilities?.requestInput === true,
    from,
    owner: input.owner,
  });
  let messageCount = 0;

  try {
    const entryPoint = resolveWorkflowEntryPoint<WorkflowCallEntryPoint>(input);
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
        messageCount += 1;
        next = await iterator.next();
      }
      output = (next.value as JsonValue | undefined) ?? last ?? null;
    }
    return { messageCount, outcome: { output, status: "completed" } };
  } catch (error) {
    return { messageCount, outcome: toFailedOutcome(error, signals.runSignal) };
  }
}

/** A body's failure, or its cancellation when the run stopped. */
export function toFailedOutcome(error: unknown, runSignal: AbortSignal): WorkflowToolRunOutcome {
  if (runSignal.aborted) {
    const { reason } = runSignal;
    return {
      reason: reason instanceof Error ? reason.message : String(reason ?? ""),
      status: "cancelled",
    };
  }
  return { error: normalizeSerializableError(error), status: "failed" };
}

export function createWorkflowBodyRef(
  input: WorkflowBodyDefinition & {
    readonly runId?: string;
  },
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
  return input.entry.entryPoint === "execute" ? ref : { ...ref, taskId: input.entry.taskId };
}

export function resolveWorkflowEntryPoint<TEntryPoint>(input: WorkflowBodyInput): TEntryPoint {
  const entryPoint = readRegisteredWorkflow(input.workflowId);
  if (typeof entryPoint !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). The tool was renamed or removed after this run started.`,
    );
  }
  return entryPoint as TEntryPoint;
}

/**
 * The members every entry point's context shares, bound to the run. `ask`
 * is the entry point's own, since what it may ask for depends on its calls.
 */
export function createSharedContext(
  input: WorkflowBodyInput,
  agentSessions: AgentSessions,
  askPerson: WorkflowSharedContext["ask"],
): Omit<ToolContext, "abortSignal" | "callId"> & WorkflowSharedContext {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  return {
    agent: (name) => agentSessions.open(name),
    agents: Object.freeze(
      Object.fromEntries(
        Object.entries(input.agents ?? {}).map(([name, metadata]) => [
          name,
          Object.freeze({ ...metadata }),
        ]),
      ),
    ),
    ask: askPerson,
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
}

/**
 * The context of an `execute` or `task` call: a task's, or, for an `execute`
 * call the turn waits on, the same plus `interruptSignal`.
 */
function createCallContext(
  input: WorkflowBodyInput,
  signals: WorkflowCallSignals,
  agentSessions: AgentSessions,
): WorkflowCallContext {
  const ctx: ToolContext & WorkflowTaskContext = {
    ...createSharedContext(input, agentSessions, (request, options) => ask(ctx, request, options)),
    abortSignal: signals.runSignal,
    callId: input.callId,
  };
  if (input.entry.entryPoint !== "execute") return ctx;
  return Object.assign(ctx, { interruptSignal: signals.interruptSignal });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}

export class WorkflowToolRunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowToolRunCancelledError";
  }
}
