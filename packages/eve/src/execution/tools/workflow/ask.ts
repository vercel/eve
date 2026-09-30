import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type {
  WorkflowToolRunAskDecision,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import type {
  ToolContext,
  ToolInputRequest,
  ToolInputRequestOptions,
  ToolInputResponse,
} from "#tools/definition.js";
import { workflowToolContextErrorMessage } from "#shared/workflow-tool-context.js";

// `Symbol.for`, not a module-local WeakMap: workflow helpers and body setup may
// be different bundled copies of this module.
const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

/**
 * The run a workflow body belongs to. Members that describe a call describe
 * the one the run serves now, which a `serve` task changes with each call, so
 * read them when they are used.
 */
export interface WorkflowToolRunContext {
  /**
   * What the call's caller lends it: the lineage a `ctx.agent` session opened
   * now binds, and whether `ctx.ask()` can reach a person.
   */
  readonly agentContext: AgentSessionContext;
  readonly asks: WorkflowToolRunAsks;
  /** The auth of the call, which a message sent to a `ctx.agent` session now carries. */
  readonly auth: SessionAuth;
  /** The run's control hook, where the session sends its decisions on the run's questions. */
  readonly control: string;
  /**
   * The ref of the call the run serves now, which questions and sign-ins come
   * from. A `serve` task's changes with each call, so read it when sending.
   */
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunInbox;
}

type WorkflowToolRunContextCarrier = {
  readonly [WORKFLOW_TOOL_RUN_CONTEXT]?: WorkflowToolRunContext;
};

export function attachWorkflowToolRunContext(
  ctx: Pick<ToolContext, "abortSignal">,
  context: WorkflowToolRunContext,
): void {
  Object.defineProperty(ctx, WORKFLOW_TOOL_RUN_CONTEXT, {
    enumerable: false,
    value: context,
  });
}

function readWorkflowToolRunContext(
  ctx: Pick<ToolContext, "abortSignal">,
  helper: "agent" | "ask",
): WorkflowToolRunContext {
  const context = (ctx as WorkflowToolRunContextCarrier | undefined)?.[WORKFLOW_TOOL_RUN_CONTEXT];
  if (context === undefined) {
    throw new Error(workflowToolContextErrorMessage(helper));
  }
  return context;
}

export function findWorkflowToolRunContext(value: unknown): WorkflowToolRunContext | undefined {
  return typeof value === "object" && value !== null
    ? (value as WorkflowToolRunContextCarrier)[WORKFLOW_TOOL_RUN_CONTEXT]
    : undefined;
}

const CANCELLED: ToolInputResponse = { status: "cancelled" };
const UNAVAILABLE: ToolInputResponse = { status: "unavailable" };

interface PendingAsk {
  readonly resolve: (response: ToolInputResponse) => void;
  readonly reject: (error: unknown) => void;
  /** Sends the session the request to withdraw the question; unset once sent. */
  withdraw: (() => Promise<void>) | undefined;
}

/**
 * The run's pending `ctx.ask()` questions. The run names each one, and each
 * resolves only from what the session decided about it, delivered in order on
 * the run's control hook, or as `cancelled` once the session stops the work.
 */
export class WorkflowToolRunAsks {
  private opened = 0;
  private readonly pending = new Map<string, PendingAsk>();
  /** Withdrawal requests on their way to the run's inbox. */
  private readonly withdrawing = new Set<Promise<void>>();
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  /**
   * Opens a question under a request ID that replays deterministically with
   * the run. `send` sends the request and returns how to send its withdrawal.
   */
  open(send: (requestId: string) => () => Promise<void>): {
    readonly answer: Promise<ToolInputResponse>;
    readonly requestId: string;
  } {
    this.opened += 1;
    const requestId = `${this.runId}-ask-${String(this.opened)}`;
    let entry!: PendingAsk;
    const answer = new Promise<ToolInputResponse>((resolve, reject) => {
      entry = { reject, resolve, withdraw: undefined };
    });
    this.pending.set(requestId, entry);
    entry.withdraw = send(requestId);
    return { answer, requestId };
  }

  /**
   * Asks the session to withdraw a pending question, at most once. The
   * question stays pending until the session decides it, so an answer the
   * session accepted first still wins.
   */
  withdraw(requestId: string): void {
    const entry = this.pending.get(requestId);
    const withdraw = entry?.withdraw;
    if (entry === undefined || withdraw === undefined) return;
    entry.withdraw = undefined;
    const sending = withdraw().catch((error: unknown) => this.fail(requestId, error));
    this.withdrawing.add(sending);
    void sending.then(() => this.withdrawing.delete(sending));
  }

  /** Asks the session to withdraw every pending question not already withdrawn. */
  withdrawAll(): void {
    for (const requestId of this.pending.keys()) this.withdraw(requestId);
  }

  /**
   * Waits until every withdrawal asked for has reached the run's inbox, so the
   * session decides each one before the run's outcome withdraws the rest.
   */
  async flush(): Promise<void> {
    while (this.withdrawing.size > 0) await Promise.all(this.withdrawing);
  }

  /** Applies the session's decision. The first one wins; a repeated one is dropped. */
  settle(decision: WorkflowToolRunAskDecision): void {
    const response = decision.kind === "answer" ? decision.response : CANCELLED;
    this.take(decision.requestId)?.resolve(response);
  }

  fail(requestId: string, error: unknown): void {
    this.take(requestId)?.reject(error);
  }

  /** The session stopped the work, so it answers none of its questions anymore. */
  cancelAll(): void {
    for (const requestId of this.pending.keys()) {
      this.take(requestId)?.resolve(CANCELLED);
    }
  }

  private take(requestId: string): PendingAsk | undefined {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    return pending;
  }
}

/**
 * Returns an answer which may be awaited or raced with another workflow
 * operation. When the call's `abortSignal` or `options.signal` aborts, the run
 * asks the session to withdraw the question. The answer is `cancelled` only if
 * the session withdrew it before it accepted a person's answer.
 */
export function ask(
  ctx: Pick<ToolContext, "abortSignal">,
  request: ToolInputRequest,
  options: ToolInputRequestOptions = {},
): Promise<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx, "ask");
  // A caller that can't reach a person resolves `ctx.ask()` as `unavailable`.
  if (context.agentContext.capabilities?.requestInput !== true) {
    return Promise.resolve(UNAVAILABLE);
  }
  const signals = [ctx.abortSignal];
  if (options.signal !== undefined) signals.push(options.signal);
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(CANCELLED);

  const { asks, control, owner } = context;
  // A `serve` task's current call changes; the question stays the call's that asked it.
  const from = context.from;
  const { answer, requestId } = asks.open((replyTo) => {
    const sent = owner.send({
      kind: "request",
      from,
      replyTo,
      request: { control, kind: "ask", request },
    });
    sent.catch((error: unknown) => asks.fail(replyTo, error));
    // The withdrawal must not overtake the request it withdraws.
    return () => sent.then(() => owner.send({ control, from, kind: "withdraw", replyTo }));
  });

  const requestWithdrawal = (): void => asks.withdraw(requestId);
  for (const signal of signals) {
    signal.addEventListener("abort", requestWithdrawal, { once: true });
  }
  return answer.finally(() => {
    for (const signal of signals) signal.removeEventListener("abort", requestWithdrawal);
  });
}
