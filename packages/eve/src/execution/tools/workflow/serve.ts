import { findStubTarget, stubCallId } from "#tool-stubs/target.js";
import { toolStubOutput } from "#tool-stubs/output.js";
import type { StubScope } from "#tool-stubs/types.js";
import type { SessionContext } from "#context/session-context.js";
import { callToolStubStep } from "#execution/tool-stubs/steps.js";
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
import type { JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  AgentSession,
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

/**
 * A call the body serves: the ref its reply is sent from, the session as the
 * call sees it, the context of the sessions opened while serving it, and the
 * agents it may open.
 */
interface ServedCall {
  readonly agentContext: AgentSessionContext;
  readonly agents: WorkflowSharedContext["agents"];
  readonly call: WorkflowServeCall<JsonValue>;
  readonly from: WorkflowToolRunRef;
  /** The run's session in the call's turn, with the auth the call was admitted with. */
  readonly session: SessionContext["session"];
}

interface PendingReceive {
  readonly promise: Promise<WorkflowServeCall<JsonValue>>;
  readonly reject: (error: Error) => void;
  readonly resolve: (call: WorkflowServeCall<JsonValue>) => void;
}

/**
 * The calls a `serve` body receives. The first arrives with the run and
 * resolves the first `receive()` in memory; later calls arrive as `call`
 * commands on the run's control hook, in the order the session sent them.
 * `ctx.reply()` settles every call received so far, and the body's outcome
 * settles the rest.
 *
 * The task works in stretches: a stretch starts when a call arrives while
 * every earlier call has a result, and ends when a reply or a cancel leaves
 * none without one. Calls in one stretch share its `abortSignal`. A cancel
 * aborts the stretch and keeps the run; `end` stops the run for good.
 */
class WorkflowServeCalls implements WorkflowBodyControl {
  /**
   * The body's questions. A cancel keeps the run, so it withdraws them
   * through the stretch's `abortSignal`, and the session decides each one.
   * A reply withdraws them too, but leaves the signal alone: it means
   * cancelled, and the body may keep working after it replies.
   */
  readonly asks: WorkflowToolRunAsks;
  private readonly run = new AbortController();
  private readonly first: ServedCall;
  /** The run's ref and session; each served call replaces the fields that describe the call. */
  private readonly runRef: WorkflowToolRunRef;
  private readonly runSession: SessionContext["session"];
  private readonly owner: WorkflowToolRunInbox;
  /**
   * What the body's `ctx.agent` sessions spent. Each reply carries the total,
   * and a turn that ends while no call waits for a reply, such as one a cancel
   * stopped, sends it on its own, since no reply would carry it.
   */
  readonly usage: RunUsageTally = createRunUsageTally(() => this.sendUncarriedUsage());
  /** The latest total a message carried, so a turn that spent nothing sends none. */
  private carriedUsage: TokenUsage | undefined;
  private readonly toolName: string;
  private readonly seenCallIds: Set<string>;
  private firstReceived = false;
  /** Calls that arrived and wait for the body's `receive()`, oldest first. */
  private arrived: ServedCall[] = [];
  /** Calls the body received that have no result yet; the first counts from the start. */
  private waiting: ServedCall[];
  /** The latest call the body received: the last of `waiting` while any call has no result. */
  private latest: ServedCall;
  private pendingReceive: PendingReceive | undefined;
  /** The current stretch of work: set while any call has no result. */
  private stretch: AbortController | undefined;
  /** A cancel stopped the body at work; it unwinds until it calls `receive()` again. */
  private unwindingCancel = false;
  private endedBy: Error | undefined;
  private replies: Promise<void> = Promise.resolve();

  constructor(input: WorkflowBodyInput) {
    this.runRef = createWorkflowBodyRef(input);
    this.asks = new WorkflowToolRunAsks(this.runRef.runId);
    this.runSession = input.session;
    this.owner = input.owner;
    this.toolName = input.toolName;
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
    return this.run.signal;
  }

  get unwinding(): boolean {
    return this.run.signal.aborted || this.unwindingCancel;
  }

  /** The signal of the work in progress, for framework waits started on the body's behalf. */
  get currentSignal(): AbortSignal {
    return this.stretch?.signal ?? this.run.signal;
  }

  /**
   * The call the body serves now: the latest call it received. Steps,
   * questions, sign-ins, and `agent.started` belong to this call, so they
   * carry its `callId` and turn; `ctx.session` is its view of the session,
   * `ctx.agents` lists the agents it may open, a session opened now is its
   * child, and a message sent now carries its auth.
   */
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
        // Steering never interrupts a task.
        return;
    }
  }

  receive(): Promise<WorkflowServeCall<JsonValue>> {
    // The first call may be cancelled already, so taking it ends no unwinding.
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
    // `ctx.ask()` needs a waiting call, and a cancel already withdrew the
    // questions of the calls it settled, so every question not yet withdrawn
    // was asked for a call this settles.
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

  /** Waits for in-flight replies and withdrawals, so the outcome can never overtake them. */
  async flush(): Promise<void> {
    await this.asks.flush();
    await this.replies;
  }

  /** Sends the usage total when no call waits for the reply that would carry it. */
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

  /** A later call reached the run. Redelivered calls are ignored. */
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

  /** The body received a call: it waits for a result and is the call served now. */
  private take(served: ServedCall): void {
    this.waiting.push(served);
    this.latest = served;
  }

  /**
   * The session cancelled the current work. It already settled the calls as
   * cancelled, so they leave the run, and a later reply is dropped.
   */
  private cancel(reason: Error): void {
    // A body already waiting in `receive()` has nothing to unwind.
    if (this.pendingReceive === undefined) this.unwindingCancel = true;
    this.stretch?.abort(reason);
    this.stretch = undefined;
    this.waiting = [];
    this.arrived = [];
  }

  /** The session ended: the work in progress aborts and no call arrives anymore. */
  private end(reason: Error): void {
    // The session is gone and decides no question anymore; settle them before
    // the aborts would ask to withdraw them.
    this.asks.cancelAll();
    this.endedBy = reason;
    this.run.abort(reason);
    this.stretch?.abort(reason);
    const pending = this.pendingReceive;
    this.pendingReceive = undefined;
    pending?.reject(reason);
  }

  /** A call joins the running stretch, or starts the next one when every call has its result. */
  private serve(call: WorkflowToolRunCall): ServedCall {
    this.stretch ??= new AbortController();
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

  /**
   * One `reply` message for every call the reply settles: the session settles
   * them in one step, so no wait wakes on one of them while the rest look
   * unanswered.
   */
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

/** Starts a `serve` body, which runs once for its task and serves every call to it. */
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
        : await serveStub(target.scope, target.tool, receive, ctx);
    outcome = { output, status: "completed" };
  } catch (error) {
    outcome = toFailedOutcome(error, calls.runSignal);
  }
  // Outside the try: a reply that never reached the run fails the run instead
  // of letting the outcome settle its calls in the reply's place.
  await calls.flush();
  return outcome;
}

/**
 * The context of a `serve` task. Framework waits and steps started through it
 * belong to the call served now, so its internal `abortSignal` follows the
 * current stretch of work, and its `agents`, `callId`, and `session` the
 * latest call received.
 */
function createServeContext(
  input: WorkflowBodyInput,
  calls: WorkflowServeCalls,
  agent: (name: string) => AgentSession,
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
    reply: (output) => calls.reply(output),
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
  scope: StubScope,
  tool: string,
  receive: WorkflowServeReceive<JsonValue>,
  ctx: ServeContext,
): Promise<JsonValue> {
  // reply() answers every received call. Reply before receiving the next call
  // so each call consumes its own stub response.
  while (true) {
    const call = await receive();
    if (call.abortSignal.aborted) continue;
    const result = await callToolStubStep(scope, {
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
