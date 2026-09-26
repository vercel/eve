import type { AgentSessions } from "#execution/agent-sessions/session.js";
import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import {
  createSharedContext,
  createWorkflowBodyRef,
  resolveWorkflowEntryPoint,
  toFailedOutcome,
  WorkflowToolRunCancelledError,
  type StartedWorkflowBody,
  type WorkflowBodyControl,
  type WorkflowBodyInput,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import type {
  WorkflowToolRunCall,
  WorkflowToolRunControlMessage,
  WorkflowToolRunOutcome,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  WorkflowServeCall,
  WorkflowServeContext,
  WorkflowServeReceive,
} from "#tools/workflow-definition.js";

type ServeContext = ToolContext & WorkflowServeContext<JsonValue>;

type ServeEntryPoint = (
  receive: WorkflowServeReceive<JsonValue>,
  ctx: ServeContext,
) => Promise<JsonValue>;

/** A call the body serves, with the ref its reply is sent from. */
interface ServedCall {
  readonly call: WorkflowServeCall<JsonValue>;
  readonly from: WorkflowToolRunRef;
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
  private readonly run = new AbortController();
  private readonly first: ServedCall;
  private readonly from: WorkflowToolRunRef;
  private readonly inbox: string;
  private readonly toolName: string;
  private readonly seenCallIds: Set<string>;
  private firstReceived = false;
  /** Calls that arrived and wait for the body's `receive()`, oldest first. */
  private arrived: ServedCall[] = [];
  /** Calls the body received that have no result yet; the first counts from the start. */
  private waiting: ServedCall[];
  private pendingReceive: PendingReceive | undefined;
  /** The current stretch of work: set while any call has no result. */
  private stretch: AbortController | undefined;
  private endedBy: Error | undefined;
  private replies: Promise<void> = Promise.resolve();
  private replyCount = 0;

  constructor(input: WorkflowBodyInput) {
    this.from = createWorkflowBodyRef(input);
    this.inbox = input.owner.inbox;
    this.toolName = input.toolName;
    this.seenCallIds = new Set([input.callId]);
    this.first = this.serve({
      callId: input.callId,
      executeInput: input.executeInput,
      input: input.input,
    });
    this.waiting = [this.first];
  }

  get runSignal(): AbortSignal {
    return this.run.signal;
  }

  /** The signal of the work in progress, for framework waits started on the body's behalf. */
  get currentSignal(): AbortSignal {
    return this.stretch?.signal ?? this.run.signal;
  }

  /** The latest call waiting for a result, whose work a step or question belongs to. */
  get currentCallId(): string {
    return (this.waiting.at(-1) ?? this.first).call.callId;
  }

  apply(command: WorkflowToolRunControlMessage): void {
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
    if (!this.firstReceived) {
      this.firstReceived = true;
      return Promise.resolve(this.first.call);
    }
    if (this.pendingReceive !== undefined) return this.pendingReceive.promise;
    if (this.endedBy !== undefined) return Promise.reject(this.endedBy);
    const next = this.arrived.shift();
    if (next !== undefined) {
      this.waiting.push(next);
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
    const previous = this.replies;
    this.replies = previous.then(() => this.deliverReplies(settled, output));
  }

  assertWaiting(): void {
    if (this.waiting.length > 0) return;
    throw new Error(
      `ctx.ask() needs a call waiting for a result, but tool "${this.toolName}" already replied to every call it received.`,
    );
  }

  /** Waits for in-flight replies, so the outcome can never overtake them. */
  async flush(): Promise<number> {
    await this.replies;
    return this.replyCount;
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
    this.waiting.push(served);
    pending.resolve(served.call);
  }

  /**
   * The session cancelled the current work. It already settled the calls as
   * cancelled, so they leave the run, and a later reply is dropped.
   */
  private cancel(reason: Error): void {
    this.stretch?.abort(reason);
    this.stretch = undefined;
    this.waiting = [];
    this.arrived = [];
  }

  /** The session ended: the work in progress aborts and no call arrives anymore. */
  private end(reason: Error): void {
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
      call: {
        abortSignal: this.stretch.signal,
        callId: call.callId,
        input: call.executeInput ?? call.input,
      },
      from: { ...this.from, callId: call.callId, input: call.input },
    };
  }

  /** One `reply` message per call, so the session settles each call once. */
  private async deliverReplies(calls: readonly ServedCall[], output: JsonValue): Promise<void> {
    for (const served of calls) {
      await resumeHookStep(this.inbox, { from: served.from, kind: "reply", output });
      this.replyCount += 1;
    }
  }
}

/** Starts a `serve` body, which runs once for its task and serves every call to it. */
export function startServeBody(
  input: WorkflowBodyInput,
  agentSessions: AgentSessions,
): StartedWorkflowBody {
  const calls = new WorkflowServeCalls(input);
  return { control: calls, result: executeServeBody(input, calls, agentSessions) };
}

async function executeServeBody(
  input: WorkflowBodyInput,
  calls: WorkflowServeCalls,
  agentSessions: AgentSessions,
): Promise<WorkflowBodyResult> {
  const ctx = createServeContext(input, calls, agentSessions);
  attachWorkflowToolRunContext(ctx, {
    // A caller that can't reach a person resolves `ctx.ask()` as `unavailable`.
    canRequestInput: input.agentContext.capabilities?.requestInput === true,
    from: createWorkflowBodyRef(input),
    owner: input.owner,
  });

  let outcome: WorkflowToolRunOutcome;
  try {
    const serve = resolveWorkflowEntryPoint<ServeEntryPoint>(input);
    const output = await serve(() => calls.receive(), ctx);
    outcome = { output, status: "completed" };
  } catch (error) {
    outcome = toFailedOutcome(error, calls.runSignal);
  }
  // Outside the try: a reply that never reached the run fails the run instead
  // of letting the outcome settle its calls in the reply's place.
  const messageCount = await calls.flush();
  return { messageCount, outcome };
}

/**
 * The context of a `serve` task. Framework waits and steps started through it
 * belong to the call waiting for a result, so its internal `abortSignal` and
 * `callId` follow the current stretch of work.
 */
function createServeContext(
  input: WorkflowBodyInput,
  calls: WorkflowServeCalls,
  agentSessions: AgentSessions,
): ServeContext {
  const ctx: ServeContext = {
    ...createSharedContext(input, agentSessions, (request, options) => {
      calls.assertWaiting();
      return ask(ctx, request, options);
    }),
    get abortSignal() {
      return calls.currentSignal;
    },
    get callId() {
      return calls.currentCallId;
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
