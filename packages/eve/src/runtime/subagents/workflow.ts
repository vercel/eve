import type {
  AgentMessageResult,
  AgentSession,
  WorkflowServeCall,
  WorkflowServeContext,
  WorkflowServeReceive,
} from "#public/tools/index.js";

/** The model's input to an agent tool; eve adds the optional `taskId`. */
export interface AgentToolInput {
  readonly message: string;
}

type AgentToolCall = WorkflowServeCall<AgentToolInput>;

type AgentToolReceive = WorkflowServeReceive<AgentToolInput>;

/** One turn of the agent's session, and the signal of the calls it answers. */
interface AgentTurn {
  readonly result: Promise<AgentMessageResult>;
  /** Aborts when the task is cancelled, which cancels the turn. */
  readonly signal: AbortSignal;
}

type AgentTurnEvent =
  | { readonly kind: "call"; readonly call: AgentToolCall }
  | { readonly kind: "result"; readonly result: AgentMessageResult };

/**
 * The `serve` body of every agent tool: local, remote, dynamic, and the
 * `agent` copy of the root. Each task talks to one session with the agent. A
 * call that arrives while the agent works joins its turn, and the turn's final
 * response settles every call it answered.
 */
export async function agentToolServeWorkflow(
  receive: AgentToolReceive,
  ctx: WorkflowServeContext<string>,
): Promise<never> {
  "use workflow";

  const agent = ctx.agent(ctx.toolName);
  let turn = sendToAgent(agent, await receive());
  for (;;) {
    const event = await nextCallOrResult(receive, turn);
    if (event.kind === "call") {
      turn = await forwardCall(agent, turn, event.call);
      continue;
    }
    // A cancel already settled the turn's calls, and the task stays available.
    if (!turn.signal.aborted) replyWithResult(ctx, event.result);
    turn = sendToAgent(agent, await receive());
  }
}

/** A cancel aborts the call's `abortSignal`, which cancels the agent's turn. */
function sendToAgent(agent: AgentSession, call: AgentToolCall): AgentTurn {
  const result = agent
    .send(call.input.message, { signal: call.abortSignal })
    .then((response) => response.result());
  return { result, signal: call.abortSignal };
}

/** A pending `receive()` is shared, so a call that loses the race is received next time. */
async function nextCallOrResult(
  receive: AgentToolReceive,
  turn: AgentTurn,
): Promise<AgentTurnEvent> {
  return await Promise.race([
    turn.result.then((result) => ({ kind: "result", result }) as const),
    receive().then((call) => ({ call, kind: "call" }) as const),
  ]);
}

/**
 * The message joins the running turn, or starts the next one if it just
 * ended. A cancelled turn is left to end first, so the message starts a turn
 * that answers it instead of joining one whose calls were already settled.
 */
async function forwardCall(
  agent: AgentSession,
  turn: AgentTurn,
  call: AgentToolCall,
): Promise<AgentTurn> {
  if (turn.signal.aborted) await turn.result.catch(() => undefined);
  return sendToAgent(agent, call);
}

function replyWithResult(ctx: WorkflowServeContext<string>, result: AgentMessageResult): void {
  if (result.status === "failed") throw new Error("The agent's session ended.");
  ctx.reply(result.message ?? "");
}
