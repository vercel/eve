import { findStubTarget, stubCallId } from "#tool-stubs/target.js";
import { toolStubOutput } from "#tool-stubs/output.js";
import { callToolStub } from "#execution/tool-stub-host.js";

import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createAgentSessions } from "#execution/agent-sessions/session.js";
import { createRunUsageTally, type RunUsageTally } from "#execution/agent-sessions/usage.js";
import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";
import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import type { WorkflowSharedContext, WorkflowToolContext } from "#tools/workflow-definition.js";
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
import type { RunHost } from "#execution/run-host.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import { withToolOutputSerializationError } from "#harness/tool-output-serialization.js";
import type { WorkflowToolRunEntry } from "#shared/action-types.js";
import { parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

export interface WorkflowBodyDefinition {
  readonly agentContext: AgentSessionContext;
  readonly callId: string;
  readonly entry: WorkflowToolRunEntry;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;

  readonly session: SessionContext["session"];
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowBodyInput extends WorkflowBodyDefinition {
  readonly hookToken: string;
  readonly owner: WorkflowToolRunInbox;
  readonly runId: string;
  readonly host: RunHost;
}

export interface WorkflowBodyControl {
  readonly runSignal: AbortSignal;
  readonly unwinding: boolean;
  apply(command: WorkflowBodyCommand): void;
}

export interface StartedWorkflowBody {
  readonly asks: WorkflowToolRunAsks;
  close(): Promise<void>;
  readonly control: WorkflowBodyControl;
  readonly outcome: Promise<WorkflowToolRunOutcome>;
  readonly usage: RunUsageTally;
}

type WorkflowCallContext = Omit<ToolContext, "messages"> & WorkflowToolContext;

const INTERRUPTED_OUTPUT = { interrupted: true } as const;

type WorkflowCallEntryPoint = (
  input: unknown,
  ctx: WorkflowCallContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

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
        this.asks.cancelAll();
        this.run.abort(new WorkflowToolRunCancelledError(command.reason));
        this.body.abort(this.run.signal.reason);
        return;
      case "interrupt":
        this.body.abort(new WorkflowToolRunInterruptedError());
        return;
      case "call":
        return;
    }
  }
}

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
    host: input.host,
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

async function executeCallBody(
  input: WorkflowBodyInput,
  ctx: WorkflowCallContext,
  signals: WorkflowCallSignals,
  from: WorkflowToolRunRef,
): Promise<WorkflowToolRunOutcome> {
  try {
    const target = findStubTarget(input.agentContext.toolStubs, input.toolName);
    if (target !== undefined) {
      const result = await callToolStub(input.host.toolStubs, target.scope, {
        callId: stubCallId(input.session.id, input.session.turn.id, input.callId),
        tool: target.tool,
        input: input.input,
      });
      if (result.kind === "error") throw new Error(result.error);
      if (result.kind === "stub")
        return { output: toolStubOutput(result.outcome), status: "completed" };
    }
    const entryPoint = resolveWorkflowEntryPoint<WorkflowCallEntryPoint>(input);
    const result = entryPoint(input.executeInput ?? input.input, ctx);
    let output: unknown;
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
      output = next.value ?? last;
    }
    return { output: toWorkflowOutput(input, output), status: "completed" };
  } catch (error) {
    if (signals.interrupted) return { output: INTERRUPTED_OUTPUT, status: "completed" };
    return toFailedOutcome(error, signals.runSignal);
  }
}

export function toWorkflowOutput(
  call: { readonly callId: string; readonly toolName: string },
  output: unknown,
): JsonValue {
  return withToolOutputSerializationError(
    { boundary: "execute", toolCallId: call.callId, toolName: call.toolName },
    () => parseJsonValue(output ?? null),
  );
}

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
    readonly runId: string;
  },
): WorkflowToolRunRef {
  const ref: WorkflowToolRunRef = {
    callId: input.callId,
    input: input.input,
    runId: input.runId,
    sequence: input.session.turn.sequence,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    turnId: input.session.turn.id,
  };
  return input.entry.entryPoint === "execute" ? ref : { ...ref, taskId: input.entry.taskId };
}

export function resolveWorkflowEntryPoint<TEntryPoint>(input: WorkflowBodyInput): TEntryPoint {
  const entryPoint =
    input.host.resolveWorkflow?.(input.workflowId) ?? readRegisteredWorkflow(input.workflowId);
  if (typeof entryPoint !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). The tool was renamed or removed after this run started.`,
    );
  }
  return entryPoint as TEntryPoint;
}

export function createSharedContext(
  input: WorkflowBodyInput,
  agent: WorkflowSharedContext["agent"],
  askPerson: WorkflowSharedContext["ask"],
): Omit<
  ToolContext & WorkflowSharedContext,
  "abortSignal" | "agents" | "callId" | "messages" | "session"
> {
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. Tool "${input.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };
  return {
    agent,
    ask: askPerson,
    getSandbox: () =>
      unavailable(
        "getSandbox()",
        'pass ctx directly to a "use step" helper to open the session\'s sandbox',
      ),
    getToken: () =>
      unavailable("getToken()", 'pass ctx directly to a "use step" helper to resolve credentials'),
    requireAuth: () =>
      unavailable(
        "requireAuth()",
        'pass ctx directly to a "use step" helper to request authorization',
      ),
    to: () => unavailable("to()", 'pass ctx directly to a "use step" helper to send to a channel'),
    channel: workflowToolChannel(input.agentContext),
    toolName: input.toolName,
  };
}

export function workflowToolChannel(context: AgentSessionContext): InstrumentationChannel {
  const projection = context.channelMetadata;
  return {
    continuationToken: context.continuationToken,
    kind: normalizeInstrumentationChannelKind(projection?.kind),
    metadata: projection?.metadata ?? {},
  };
}

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

function createCallContext(
  input: WorkflowBodyInput,
  signals: WorkflowCallSignals,
  agent: WorkflowSharedContext["agent"],
): WorkflowCallContext {
  const ctx: WorkflowCallContext = {
    ...createSharedContext(input, agent, (request, options) => ask(ctx, request, options)),
    abortSignal: signals.abortSignal,
    agents: createAgentsView(input.agentContext),
    callId: input.callId,
    session: input.session,
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

export class WorkflowToolRunInterruptedError extends Error {
  constructor() {
    super("A new message arrived while the turn waited on this call.");
    this.name = "WorkflowToolRunInterruptedError";
  }
}
