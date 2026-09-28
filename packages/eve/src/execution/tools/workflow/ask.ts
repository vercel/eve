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
  ctx: ToolContext,
  context: WorkflowToolRunContext,
): void {
  Object.defineProperty(ctx, WORKFLOW_TOOL_RUN_CONTEXT, {
    enumerable: false,
    value: context,
  });
}

function readWorkflowToolRunContext(
  ctx: ToolContext,
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
}

/**
 * The run's pending `ctx.ask()` questions. The run names each one, and each
 * resolves only from what the session decided about it, delivered in order on
 * the run's control hook, or as `cancelled` once the session stops the work.
 */
export class WorkflowToolRunAsks {
  private opened = 0;
  private readonly pending = new Map<string, PendingAsk>();
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  /** Opens a question under a request ID that replays deterministically with the run. */
  open(): { readonly answer: Promise<ToolInputResponse>; readonly requestId: string } {
    this.opened += 1;
    const requestId = `${this.runId}-ask-${String(this.opened)}`;
    const answer = new Promise<ToolInputResponse>((resolve, reject) => {
      this.pending.set(requestId, { reject, resolve });
    });
    return { answer, requestId };
  }

  isPending(requestId: string): boolean {
    return this.pending.has(requestId);
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
  ctx: ToolContext,
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
  const { answer, requestId } = asks.open();
  // A `serve` task's current call changes; the question stays the call's that asked it.
  const from = context.from;
  const sent = owner.send({
    kind: "request",
    from,
    replyTo: requestId,
    request: { control, kind: "ask", request },
  });
  sent.catch((error: unknown) => asks.fail(requestId, error));

  const requestWithdrawal = (): void => {
    if (!asks.isPending(requestId)) return;
    // The withdrawal must not overtake the request it withdraws.
    const withdrawal = sent.then(() =>
      owner.send({ control, from, kind: "withdraw", replyTo: requestId }),
    );
    withdrawal.catch((error: unknown) => asks.fail(requestId, error));
  };
  for (const signal of signals) {
    signal.addEventListener("abort", requestWithdrawal, { once: true });
  }
  return answer.finally(() => {
    for (const signal of signals) signal.removeEventListener("abort", requestWithdrawal);
  });
}
