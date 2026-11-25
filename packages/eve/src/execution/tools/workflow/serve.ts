import { findStubTarget, stubCallId } from "#tool-stubs/target.js";
import { toolStubOutput } from "#tool-stubs/output.js";
import type { StubScope } from "#tool-stubs/types.js";
import type { SessionContext } from "#context/session-context.js";
import { callToolStub, type ToolStubHost } from "#execution/tool-stub-host.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createAgentSessions } from "#execution/agent-sessions/session.js";
import { createRunUsageTally, type RunUsageTally } from "#execution/agent-sessions/usage.js";
import {
  ask,
  attachWorkflowToolRunContext,
  WorkflowToolRunAsks,
  type WorkflowToolRunContext,
} from "#execution/tools/workflow/ask.js";
import {
  createAgentsView,
  createSharedContext,
  createWorkflowBodyRef,
  resolveWorkflowEntryPoint,
  toFailedOutcome,
  toWorkflowOutput,
  WorkflowToolRunCancelledError,
  type StartedWorkflowBody,
  type WorkflowBodyControl,
  type WorkflowBodyInput,
} from "#execution/tools/workflow/body.js";
import type {
  WorkflowBodyCommand,
  WorkflowToolRunCall,
  WorkflowToolRunOutcome,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import { agentToolServeWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import type { JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  WorkflowServeCall,
  WorkflowServeContext,
  WorkflowServeReceive,
  WorkflowSharedContext,
} from "#tools/workflow-definition.js";

type ServeContext = Omit<ToolContext, "messages"> & WorkflowServeContext<JsonValue>;

type ServeEntryPoint = (
  receive: WorkflowServeReceive<JsonValue>,
  ctx: ServeContext,
) => Promise<JsonValue>;

interface ServedCall {
  readonly agentContext: AgentSessionContext;
  readonly agents: WorkflowSharedContext["agents"];
  readonly call: WorkflowServeCall<JsonValue>;
  readonly from: WorkflowToolRunRef;
  readonly session: SessionContext["session"];
}

interface PendingReceive {
  readonly promise: Promise<WorkflowServeCall<JsonValue>>;
  readonly reject: (error: Error) => void;
  readonly resolve: (call: WorkflowServeCall<JsonValue>) => void;
}

const AGENT_MODELS_SERVE_WORKFLOW_ID = `workflow//${EVE_PACKAGE_NAME}//agentModelsServeWorkflow`;

function usesInWorkflowStretchAbort(workflowId: string): boolean {
  return (
    workflowId === agentToolServeWorkflowReference.workflowId ||
    workflowId === AGENT_MODELS_SERVE_WORKFLOW_ID
  );
}

interface StretchAbortControl {
  readonly signal: AbortSignal;
  abort(reason: unknown): void;
}

type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];

class InWorkflowAbortSignal implements AbortSignal, StretchAbortControl {
  aborted = false;
  onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
  reason: unknown = undefined;
  private readonly listeners = new Map<AbortListener, () => void>();

  get signal(): AbortSignal {
    return this;
  }

  addEventListener(type: string, listener: AbortListener): void {
    if (type !== "abort" || listener === null) return;
    const invoke =
      typeof listener === "function"
        ? () => listener.call(this, { type: "abort" } as Event)
        : () => listener.handleEvent({ type: "abort" } as Event);
    if (this.aborted) {
      invoke();
      return;
    }
    this.listeners.set(listener, invoke);
  }

  removeEventListener(type: string, listener: AbortListener): void {
    if (type !== "abort" || listener === null) return;
    this.listeners.delete(listener);
  }

  dispatchEvent(): boolean {
    return true;
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const event = { type: "abort" } as Event;
    this.onabort?.call(this, event);
    const pending = Array.from(this.listeners.values());
    this.listeners.clear();
    for (const invoke of pending) invoke();
  }
}

class WorkflowServeCalls implements WorkflowBodyControl {
  readonly asks: WorkflowToolRunAsks;
  private readonly run = new InWorkflowAbortSignal();
  private readonly first: ServedCall;
  private readonly runRef: WorkflowToolRunRef;
  private readonly runSession: SessionContext["session"];
  private readonly owner: WorkflowToolRunInbox;
  readonly usage: RunUsageTally = createRunUsageTally(() => this.sendUncarriedUsage());
  private carriedUsage: TokenUsage | undefined;
  private readonly toolName: string;
  private readonly inWorkflowStretchAbort: boolean;
  private readonly seenCallIds: Set<string>;
  private firstReceived = false;
  private arrived: ServedCall[] = [];
  private waiting: ServedCall[];
  private latest: ServedCall;
  private pendingReceive: PendingReceive | undefined;
  private stretch: StretchAbortControl | undefined;
  private unwindingCancel = false;
  private endedBy: Error | undefined;
  private replies: Promise<void> = Promise.resolve();

  constructor(input: WorkflowBodyInput) {
    this.runRef = createWorkflowBodyRef(input);
    this.asks = new WorkflowToolRunAsks(this.runRef.runId);
    this.runSession = input.session;
    this.owner = input.owner;
    this.toolName = input.toolName;
    this.inWorkflowStretchAbort = usesInWorkflowStretchAbort(input.workflowId);
    this.seenCallIds = new Set([input.callId]);
    this.first = this.serve({
      agentContext: input.agentContext,
      auth: input.session.auth,
      callId: this.runRef.callId,
      executeInput: input.executeInput,
      input: this.runRef.input,
      sequence: this.runRef.sequence,
      stepIndex: this.runRef.stepIndex,
      turnId: this.runRef.turnId,
    });
    this.waiting = [this.first];
    this.latest = this.first;
  }

  get runSignal(): AbortSignal {
    return this.run;
  }

  get unwinding(): boolean {
    return this.run.aborted || this.unwindingCancel;
  }

  get currentSignal(): AbortSignal {
    return this.stretch?.signal ?? this.runSignal;
  }

  get current(): ServedCall {
    return this.latest;
  }

  apply(command: WorkflowBodyCommand): void {
    switch (command.kind) {
      case "call":
        this.accept(command.call);
        return;
      case "cancel":
        this.cancel(new WorkflowToolRunCancelledError(command.reason));
        return;
      case "end":
        this.end(new WorkflowToolRunCancelledError(command.reason));
        return;
      case "interrupt":
        return;
    }
  }

  receive(): Promise<WorkflowServeCall<JsonValue>> {
    if (!this.firstReceived) {
      this.firstReceived = true;
      return Promise.resolve(this.first.call);
    }
    this.unwindingCancel = false;
    if (this.pendingReceive !== undefined) return this.pendingReceive.promise;
    if (this.endedBy !== undefined) return Promise.reject(this.endedBy);
    const next = this.arrived.shift();
    if (next !== undefined) {
      this.take(next);
      return Promise.resolve(next.call);
    }
    this.pendingReceive = createPendingReceive();
    return this.pendingReceive.promise;
  }

  reply(output: JsonValue): void {
    const settled = this.waiting;
    if (settled.length === 0) return;
    this.waiting = [];
    if (this.arrived.length === 0) this.stretch = undefined;
    this.asks.withdrawAll();
    const previous = this.replies;
    this.replies = previous.then(() => this.deliverReply(settled, output));
  }

  assertWaiting(): void {
    if (this.waiting.length > 0) return;
    throw new Error(
      `ctx.ask() needs a call waiting for a result, but tool "${this.toolName}" already replied to every call it received.`,
    );
  }

  async flush(): Promise<void> {
    await this.asks.flush();
    await this.replies;
  }

  private sendUncarriedUsage(): void {
    if (this.waiting.length > 0 || this.endedBy !== undefined) return;
    const { from } = this.latest;
    this.replies = this.replies.then(async () => {
      const usage = this.usage.total();
      if (usage === undefined || isSameUsage(usage, this.carriedUsage)) return;
      this.carriedUsage = usage;
      await this.owner.send({ from, kind: "usage", usage });
    });
  }

  private accept(call: WorkflowToolRunCall): void {
    if (this.endedBy !== undefined || this.seenCallIds.has(call.callId)) return;
    this.seenCallIds.add(call.callId);
    const served = this.serve(call);
    const pending = this.pendingReceive;
    if (pending === undefined) {
      this.arrived.push(served);
      return;
    }
    this.pendingReceive = undefined;
    this.take(served);
    pending.resolve(served.call);
  }

  private take(served: ServedCall): void {
    this.waiting.push(served);
    this.latest = served;
  }

  private cancel(reason: Error): void {
    if (this.pendingReceive === undefined) this.unwindingCancel = true;
    this.stretch?.abort(reason);
    this.stretch = undefined;
    this.waiting = [];
    this.arrived = [];
  }

  private end(reason: Error): void {
    this.asks.cancelAll();
    this.endedBy = reason;
    this.run.abort(reason);
    this.stretch?.abort(reason);
    const pending = this.pendingReceive;
    this.pendingReceive = undefined;
    pending?.reject(reason);
  }

  private serve(call: WorkflowToolRunCall): ServedCall {
    this.stretch ??= this.inWorkflowStretchAbort
      ? new InWorkflowAbortSignal()
      : new AbortController();
    return {
      agentContext: call.agentContext,
      agents: createAgentsView(call.agentContext),
      call: {
        abortSignal: this.stretch.signal,
        callId: call.callId,
        input: call.executeInput ?? call.input,
      },
      from: {
        ...this.runRef,
        callId: call.callId,
        input: call.input,
        sequence: call.sequence,
        stepIndex: call.stepIndex,
        turnId: call.turnId,
      },
      session: {
        ...this.runSession,
        auth: call.auth,
        turn: { id: call.turnId, sequence: call.sequence },
      },
    };
  }

  private async deliverReply(calls: readonly ServedCall[], output: JsonValue): Promise<void> {
    const latest = calls.at(-1);
    if (latest === undefined) return;
    const callIds = calls.map((served) => served.from.callId);
    const usage = this.usage.total();
    this.carriedUsage = usage;
    await this.owner.send({
      callIds,
      from: latest.from,
      kind: "reply",
      output,
      ...(usage !== undefined && { usage }),
    });
  }
}

function isSameUsage(total: TokenUsage, carried: TokenUsage | undefined): boolean {
  return (
    carried !== undefined &&
    total.inputTokens === carried.inputTokens &&
    total.outputTokens === carried.outputTokens &&
    total.cacheReadTokens === carried.cacheReadTokens &&
    total.cacheWriteTokens === carried.cacheWriteTokens &&
    total.costUsd === carried.costUsd
  );
}

export function startServeBody(input: WorkflowBodyInput): StartedWorkflowBody {
  const calls = new WorkflowServeCalls(input);
  const run: WorkflowToolRunContext = {
    get agentContext() {
      return calls.current.agentContext;
    },
    asks: calls.asks,
    get auth() {
      return calls.current.session.auth;
    },
    control: input.hookToken,
    get from() {
      return calls.current.from;
    },
    host: input.host,
    owner: input.owner,
  };
  const agentSessions = createAgentSessions(run, calls.usage);
  const ctx = createServeContext(input, calls, agentSessions.open);
  attachWorkflowToolRunContext(ctx, run);
  return {
    asks: calls.asks,
    close: agentSessions.close,
    control: calls,
    outcome: executeServeBody(input, calls, ctx),
    usage: calls.usage,
  };
}

async function executeServeBody(
  input: WorkflowBodyInput,
  calls: WorkflowServeCalls,
  ctx: ServeContext,
): Promise<WorkflowToolRunOutcome> {
  let outcome: WorkflowToolRunOutcome;
  try {
    const target = findStubTarget(input.agentContext.toolStubs, input.toolName);
    const receive = () => calls.receive();
    const output =
      target === undefined
        ? await resolveWorkflowEntryPoint<ServeEntryPoint>(input)(receive, ctx)
        : await serveStub(input.host.toolStubs, target.scope, target.tool, receive, ctx);
    outcome = { output: toWorkflowOutput(input, output), status: "completed" };
  } catch (error) {
    outcome = toFailedOutcome(error, calls.runSignal);
  }
  await calls.flush();
  return outcome;
}

function createServeContext(
  input: WorkflowBodyInput,
  calls: WorkflowServeCalls,
  agent: WorkflowSharedContext["agent"],
): ServeContext {
  const ctx: ServeContext = {
    ...createSharedContext(input, agent, (request, options) => {
      calls.assertWaiting();
      return ask(ctx, request, options);
    }),
    get abortSignal() {
      return calls.currentSignal;
    },
    get agents() {
      return calls.current.agents;
    },
    get callId() {
      return calls.current.from.callId;
    },
    get session() {
      return calls.current.session;
    },
    reply: (output) =>
      calls.reply(toWorkflowOutput({ callId: ctx.callId, toolName: input.toolName }, output)),
  };
  return ctx;
}

function createPendingReceive(): PendingReceive {
  let resolve!: (call: WorkflowServeCall<JsonValue>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WorkflowServeCall<JsonValue>>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function serveStub(
  stubs: ToolStubHost | undefined,
  scope: StubScope,
  tool: string,
  receive: WorkflowServeReceive<JsonValue>,
  ctx: ServeContext,
): Promise<JsonValue> {
  while (true) {
    const call = await receive();
    if (call.abortSignal.aborted) continue;
    const result = await callToolStub(stubs, scope, {
      callId: stubCallId(ctx.session.id, ctx.session.turn.id, call.callId),
      input: call.input,
      tool,
      persistent: true,
    });
    if (result.kind !== "stub")
      throw new Error(
        result.kind === "error" ? result.error : "Persistent stub configuration changed.",
      );
    ctx.reply(toolStubOutput(result.outcome));
  }
}
