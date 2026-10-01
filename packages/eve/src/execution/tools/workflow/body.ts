import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createAgentSessions } from "#execution/agent-sessions/session.js";
import { createRunUsageTally, type RunUsageTally } from "#execution/agent-sessions/usage.js";
import type {
  AgentSession,
  WorkflowSharedContext,
  WorkflowToolContext,
} from "#tools/workflow-definition.js";
import {
  ask,
  attachWorkflowToolRunContext,
  WorkflowToolRunAsks,
  type WorkflowToolRunContext,
} from "#execution/tools/workflow/ask.js";
import type {
  WorkflowBodyCommand,
  WorkflowToolRunOutcome,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import type { WorkflowToolRunEntry } from "#shared/action-types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

export interface WorkflowBodyDefinition {
  /** Everything the run needs to open `ctx.agent` sessions for its caller, and `ctx.agents`. */
  readonly agentContext: AgentSessionContext;
  readonly callId: string;
  /** The entry point the run invokes, which decides the body's context. */
  readonly entry: WorkflowToolRunEntry;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;

  readonly session: SessionContext["session"];
  readonly turn: SessionContext["turn"];
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowBodyInput extends WorkflowBodyDefinition {
  /** The run's control hook, which the session answers the body's questions on. */
  readonly hookToken: string;
  readonly owner: WorkflowToolRunInbox;
  readonly runId?: string;
}

/**
 * How the session's commands reach a running body. What a command means
 * depends on the entry point: a cancel ends an `execute` or `task` call, but
 * only the current stretch of work of a `serve` task.
 */
export interface WorkflowBodyControl {
  /** Aborts when the run stops for good; the run then settles as cancelled. */
  readonly runSignal: AbortSignal;
  /** The body is winding down cancelled work, which the run bounds with its cleanup deadline. */
  readonly unwinding: boolean;
  apply(command: WorkflowBodyCommand): void;
}

/** A body the run started and how its commands reach it. */
export interface StartedWorkflowBody {
  /** The body's pending questions, which the session's decisions settle. */
  readonly asks: WorkflowToolRunAsks;
  /** Releases what the body opened, such as its `ctx.agent` sessions, once the run ends. */
  close(): Promise<void>;
  readonly control: WorkflowBodyControl;
  readonly outcome: Promise<WorkflowToolRunOutcome>;
  /** What the body's `ctx.agent` sessions spent, which the run's outcome carries. */
  readonly usage: RunUsageTally;
}

// Workflow bodies replay deterministically, so they never receive model messages.
type WorkflowCallContext = Omit<ToolContext, "messages"> & WorkflowToolContext;

/** What an `execute` call a steering message stopped settles with when its body rejects. */
const INTERRUPTED_OUTPUT = { interrupted: true } as const;

type WorkflowCallEntryPoint = (
  input: unknown,
  ctx: WorkflowCallContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/**
 * The signals of an `execute` or `task` call, which the run's commands abort.
 * The body's `abortSignal` aborts on a cancel and on an interrupt; the run's
 * signal only on a cancel, because an interrupted call still settles with the
 * body's result.
 */
class WorkflowCallSignals implements WorkflowBodyControl {
  private readonly body = new AbortController();
  private readonly run = new AbortController();
  private readonly asks: WorkflowToolRunAsks;

  constructor(asks: WorkflowToolRunAsks) {
    this.asks = asks;
  }

  get abortSignal(): AbortSignal {
    return this.body.signal;
  }

  get runSignal(): AbortSignal {
    return this.run.signal;
  }

  /** A steering message stopped the body, and no cancel has. */
  get interrupted(): boolean {
    return this.body.signal.aborted && !this.run.signal.aborted;
  }

  get unwinding(): boolean {
    return this.run.signal.aborted;
  }

  apply(command: WorkflowBodyCommand): void {
    switch (command.kind) {
      case "cancel":
      case "end":
        // The session retired the call's questions when it stopped the call,
        // so it accepts no answer after this; settle them before the abort
        // would ask to withdraw them.
        this.asks.cancelAll();
        this.run.abort(new WorkflowToolRunCancelledError(command.reason));
        this.body.abort(this.run.signal.reason);
        return;
      case "interrupt":
        this.body.abort(new WorkflowToolRunInterruptedError());
        return;
      case "call":
        // Only a `serve` task takes later calls.
        return;
    }
  }
}

/** Starts the body of an `execute` or `task` call, which serves the call the run started with. */
export function startCallBody(input: WorkflowBodyInput): StartedWorkflowBody {
  const from = createWorkflowBodyRef(input);
  const asks = new WorkflowToolRunAsks(from.runId);
  const signals = new WorkflowCallSignals(asks);
  const run: WorkflowToolRunContext = {
    agentContext: input.agentContext,
    asks,
    auth: input.session.auth,
    control: input.hookToken,
    from,
    owner: input.owner,
  };
  const usage = createRunUsageTally();
  const agentSessions = createAgentSessions(run, usage);
  const ctx = createCallContext(input, signals, agentSessions.open);
  attachWorkflowToolRunContext(ctx, run);
  return {
    asks,
    close: agentSessions.close,
    control: signals,
    outcome: executeCallBody(input, ctx, signals, from),
    usage,
  };
}

/** Executes one call's registered workflow body and reports progress to its owner. */
async function executeCallBody(
  input: WorkflowBodyInput,
  ctx: WorkflowCallContext,
  signals: WorkflowCallSignals,
  from: WorkflowToolRunRef,
): Promise<WorkflowToolRunOutcome> {
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
        await input.owner.send({ from, kind: "report", update: next.value });
        next = await iterator.next();
      }
      output = (next.value as JsonValue | undefined) ?? last ?? null;
    }
    return { output, status: "completed" };
  } catch (error) {
    if (signals.interrupted) return { output: INTERRUPTED_OUTPUT, status: "completed" };
    return toFailedOutcome(error, signals.runSignal);
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
 * The members that describe a call, `abortSignal`, `agents`, `callId`,
 * `session` (whose turn is the call's), and `turn`, come from the entry point,
 * which knows its calls.
 */
export function createSharedContext(
  input: WorkflowBodyInput,
  agent: (name: string) => AgentSession,
  askPerson: WorkflowSharedContext["ask"],
): Omit<
  ToolContext & WorkflowSharedContext,
  "abortSignal" | "agents" | "callId" | "messages" | "session" | "turn"
> {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  return {
    agent,
    ask: askPerson,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getToken: () =>
      unavailable("getToken()", 'pass ctx directly to a "use step" helper to resolve credentials'),
    requireAuth: () =>
      unavailable(
        "requireAuth()",
        'pass ctx directly to a "use step" helper to request authorization',
      ),
    toolName: input.toolName,
  };
}

/** `ctx.agents` for a call: the agents its context lists, frozen. */
export function createAgentsView(context: AgentSessionContext): WorkflowSharedContext["agents"] {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(context.agents).map(([name, metadata]) => [
        name,
        Object.freeze({ ...metadata }),
      ]),
    ),
  );
}

/**
 * The context of an `execute` or `task` call. They differ only in what aborts
 * `abortSignal`: the session interrupts only the `execute` calls a turn waits on.
 */
function createCallContext(
  input: WorkflowBodyInput,
  signals: WorkflowCallSignals,
  agent: (name: string) => AgentSession,
): WorkflowCallContext {
  const ctx: WorkflowCallContext = {
    ...createSharedContext(input, agent, (request, options) => ask(ctx, request, options)),
    abortSignal: signals.abortSignal,
    agents: createAgentsView(input.agentContext),
    callId: input.callId,
    session: input.session,
    turn: input.turn,
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

export class WorkflowToolRunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowToolRunCancelledError";
  }
}

/** Why an `execute` call's `abortSignal` aborted when a steering message arrived. */
export class WorkflowToolRunInterruptedError extends Error {
  constructor() {
    super("A new message arrived while the turn waited on this call.");
    this.name = "WorkflowToolRunInterruptedError";
  }
}
