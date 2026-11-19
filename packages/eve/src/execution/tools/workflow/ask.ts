import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { RunHost } from "#execution/run-host.js";
import type {
  WorkflowToolRunAskDecision,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import type { ToolContext, ToolQuestion, ToolAskOptions, ToolAnswer } from "#tools/definition.js";
import { workflowToolContextErrorMessage } from "#shared/workflow-tool-context.js";

const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

export interface WorkflowToolRunContext {
  readonly agentContext: AgentSessionContext;
  readonly asks: WorkflowToolRunAsks;
  readonly auth: SessionAuth;
  readonly control: string;
  readonly from: WorkflowToolRunRef;
  readonly host: RunHost;
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

const CANCELLED: ToolAnswer = { status: "cancelled" };
const UNAVAILABLE: ToolAnswer = { status: "unavailable" };

interface PendingAsk {
  readonly resolve: (response: ToolAnswer) => void;
  withdraw: (() => Promise<void>) | undefined;
}

export class WorkflowToolRunAsks {
  private opened = 0;
  private readonly pending = new Map<string, PendingAsk>();
  private readonly withdrawing = new Set<Promise<void>>();
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  open(send: (requestId: string) => () => Promise<void>): {
    readonly answer: Promise<ToolAnswer>;
    readonly requestId: string;
  } {
    this.opened += 1;
    const requestId = `${this.runId}-ask-${String(this.opened)}`;
    let entry!: PendingAsk;
    const answer = new Promise<ToolAnswer>((resolve) => {
      entry = { resolve, withdraw: undefined };
    });
    this.pending.set(requestId, entry);
    entry.withdraw = send(requestId);
    return { answer, requestId };
  }

  withdraw(requestId: string): void {
    const entry = this.pending.get(requestId);
    const withdraw = entry?.withdraw;
    if (entry === undefined || withdraw === undefined) return;
    entry.withdraw = undefined;
    const sending = withdraw();
    this.withdrawing.add(sending);
    void sending.then(() => this.withdrawing.delete(sending));
  }

  withdrawAll(): void {
    for (const requestId of this.pending.keys()) this.withdraw(requestId);
  }

  async flush(): Promise<void> {
    while (this.withdrawing.size > 0) await Promise.all(this.withdrawing);
  }

  settle(decision: WorkflowToolRunAskDecision): void {
    const response = decision.kind === "answer" ? decision.response : CANCELLED;
    this.take(decision.requestId)?.resolve(response);
  }

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

export function ask(
  ctx: Pick<ToolContext, "abortSignal">,
  request: ToolQuestion,
  options: ToolAskOptions = {},
): Promise<ToolAnswer> {
  const context = readWorkflowToolRunContext(ctx, "ask");
  const { initialOptionId } = request;
  if (
    request.display === "select" &&
    initialOptionId !== undefined &&
    !request.options?.some((option) => option.id === initialOptionId)
  ) {
    throw new TypeError(
      `ctx.ask(): \`initialOptionId\` ${JSON.stringify(initialOptionId)} must match one of the question's \`options\` ids.`,
    );
  }
  if (context.agentContext.capabilities?.requestInput !== true) {
    return Promise.resolve(UNAVAILABLE);
  }
  const signals = [ctx.abortSignal];
  if (options.signal !== undefined) signals.push(options.signal);
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(CANCELLED);

  const { asks, control, owner } = context;
  const from = context.from;
  const { answer, requestId } = asks.open((replyTo) => {
    const sent = owner.send({
      kind: "request",
      from,
      replyTo,
      request: { control, kind: "ask", request },
    });
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
