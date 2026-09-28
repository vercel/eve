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
  let next = receive();
  for (;;) {
    const event = await nextCallOrResult(next, turn);
    if (event.kind === "call") {
      turn = await forwardCall(agent, turn, event.call);
      next = receive();
      continue;
    }
    // A cancel already settled the turn's calls, and the task stays available.
    if (!turn.signal.aborted) {
      if (event.result.status === "failed") {
        throw new Error(
          `The agent's turn failed: ${event.result.error?.message ?? "no reason given"}`,
        );
      }
      // `next` can take a call after the result wins the race, and the reply
      // would settle that call unread. `receive()` returns `next` only while
      // it's pending, so another promise means the agent reads that call
      // first. Nothing may await between this check and the reply. The
      // session's end aborts the turn, so `following` can't reject here.
      const following = receive();
      if (following !== next) {
        turn = sendToAgent(agent, await next);
        next = following;
        continue;
      }
      ctx.reply(event.result.message ?? "");
    }
    turn = sendToAgent(agent, await next);
    next = receive();
  }
}

/** A cancel aborts the call's `abortSignal`, which cancels the agent's turn. */
function sendToAgent(agent: AgentSession, call: AgentToolCall): AgentTurn {
  const result = agent
    .send(call.input.message, { signal: call.abortSignal })
    .then((response) => response.result());
  return { result, signal: call.abortSignal };
}

/** `next` may take a call even when the turn's result wins, so the loop keeps it until it's read. */
async function nextCallOrResult(
  next: Promise<AgentToolCall>,
  turn: AgentTurn,
): Promise<AgentTurnEvent> {
  return await Promise.race([
    turn.result.then((result) => ({ kind: "result", result }) as const),
    next.then((call) => ({ call, kind: "call" }) as const),
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
