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

/** The model's input to an `agent({ models })` tool: `model` is one of the tool's model keys. */
export interface AgentModelsToolInput extends AgentToolInput {
  readonly model?: string;
}

type AgentToolCall = WorkflowServeCall<AgentToolInput>;

type AgentToolReceive = WorkflowServeReceive<AgentToolInput>;

type AgentModelsToolCall = WorkflowServeCall<AgentModelsToolInput>;

type AgentModelsToolReceive = WorkflowServeReceive<AgentModelsToolInput>;

interface AgentTurn {
  readonly result: Promise<AgentMessageResult>;
  readonly signal: AbortSignal;
}

type AgentTurnEvent =
  | { readonly kind: "call"; readonly call: AgentToolCall }
  | { readonly kind: "result"; readonly result: AgentMessageResult };

type AgentModelsTurnEvent =
  | { readonly kind: "call"; readonly call: AgentModelsToolCall }
  | { readonly kind: "result"; readonly result: AgentMessageResult };

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
    if (!turn.signal.aborted) {
      if (event.result.status === "failed") {
        throw new Error(
          `The agent's turn failed: ${event.result.error.message}\nThis task has ended; to retry, call ${ctx.toolName} without taskId.`,
        );
      }
      const following = receive();
      if (following !== next) {
        turn = sendToAgent(agent, await next);
        next = following;
        continue;
      }
      ctx.reply(event.result.reply ?? "");
    }
    turn = sendToAgent(agent, await next);
    next = receive();
  }
}

export async function agentModelsServeWorkflow(
  receive: AgentModelsToolReceive,
  ctx: WorkflowServeContext<string>,
): Promise<never> {
  "use workflow";

  const first = await receive();
  const model = first.input.model;
  const agent = ctx.agent("agent", model === undefined ? undefined : { model });
  let turn = sendToModelAgent(agent, first, model);
  let next = receive();
  for (;;) {
    const event = await nextModelCallOrResult(next, turn);
    if (event.kind === "call") {
      turn = await forwardModelCall(agent, turn, event.call, model);
      next = receive();
      continue;
    }
    if (!turn.signal.aborted) {
      if (event.result.status === "failed") {
        throw new Error(
          `The agent's turn failed: ${event.result.error.message}\nThis task has ended; to retry, call ${ctx.toolName} without taskId.`,
        );
      }
      const following = receive();
      if (following !== next) {
        turn = sendToModelAgent(agent, await next, model);
        next = following;
        continue;
      }
      ctx.reply(event.result.reply ?? "");
    }
    turn = sendToModelAgent(agent, await next, model);
    next = receive();
  }
}

function sendToAgent(agent: AgentSession, call: AgentToolCall): AgentTurn {
  const result = agent
    .send(call.input.message, { signal: call.abortSignal })
    .then((response) => response.result());
  return { result, signal: call.abortSignal };
}

function sendToModelAgent(
  agent: AgentSession,
  call: AgentModelsToolCall,
  model: string | undefined,
): AgentTurn {
  if (call.input.model !== undefined && call.input.model !== model) {
    throw new Error(
      "An agent task keeps the model it started with. This task has ended; start a new task to use another model.",
    );
  }
  const result = agent
    .send(call.input.message, { signal: call.abortSignal })
    .then((response) => response.result());
  return { result, signal: call.abortSignal };
}

async function nextCallOrResult(
  next: Promise<AgentToolCall>,
  turn: AgentTurn,
): Promise<AgentTurnEvent> {
  return await Promise.race([
    turn.result.then((result) => ({ kind: "result", result }) as const),
    next.then((call) => ({ call, kind: "call" }) as const),
  ]);
}

async function nextModelCallOrResult(
  next: Promise<AgentModelsToolCall>,
  turn: AgentTurn,
): Promise<AgentModelsTurnEvent> {
  return await Promise.race([
    turn.result.then((result) => ({ kind: "result", result }) as const),
    next.then((call) => ({ call, kind: "call" }) as const),
  ]);
}

async function forwardCall(
  agent: AgentSession,
  turn: AgentTurn,
  call: AgentToolCall,
): Promise<AgentTurn> {
  if (turn.signal.aborted) await turn.result.catch(() => undefined);
  return sendToAgent(agent, call);
}

async function forwardModelCall(
  agent: AgentSession,
  turn: AgentTurn,
  call: AgentModelsToolCall,
  model: string | undefined,
): Promise<AgentTurn> {
  if (turn.signal.aborted) await turn.result.catch(() => undefined);
  return sendToModelAgent(agent, call, model);
}
