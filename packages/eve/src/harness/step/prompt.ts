import { changeHistory } from "#harness/session-machine/history.js";
import { appendTaskContext } from "#execution/tasks/model-step.js";
import {
  anchorToTurn,
  createFrameworkUserMessage,
  followsToolResults,
  type HarnessModelMessage,
  normalizeModelMessages,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { hasUnansweredToolCall } from "#harness/model-call/response.js";
import { repairToolHistory } from "#harness/tool-history-repair.js";
import {
  getTurnClientContextState,
  setTurnClientContextState,
} from "#harness/turn-client-context.js";
import type { Step } from "./context.js";
import { followingToolResults, type TurnInput } from "./intake.js";

type ClientContext = NonNullable<ReturnType<typeof getTurnClientContextState>>;

/**
 * What the model reads this step: durable history, which holds the turn's input, with the task
 * results the step delivers, and the client's context for the turn, which keeps one position
 * across the turn's steps and never joins history.
 */
export interface Prompt {
  /** Durable messages. Compaction may rewrite them. */
  messages: HarnessModelMessage[];
  clientContext: ClientContext | undefined;
}

export async function buildPrompt(step: Step, turn: TurnInput): Promise<Prompt> {
  const built = await settleHistory(step, turn);
  return {
    clientContext: getTurnClientContextState(step.session.state, turn.turnId),
    messages: built.messages,
  };
}

/**
 * History repaired and with the task results the step delivers, and the turn as the repair left
 * its client context's position.
 */
async function settleHistory(
  step: Step,
  turn: TurnInput,
): Promise<{ readonly messages: HarnessModelMessage[]; readonly turn: TurnInput }> {
  const repaired = repairToolHistory({
    endsRequest: turn.messages.length === 0,
    messages: step.session.history,
    insertionIndex: turn.storedClientContext?.insertionIndex,
  });
  step.session = changeHistory(step.session, { repaired: repaired.messages });
  // Its own copy: task results join it below.
  const messages = [...step.session.history];
  if (turn.storedClientContext !== undefined && repaired.insertionIndex !== undefined) {
    const storedClientContext = {
      ...turn.storedClientContext,
      insertionIndex: repaired.insertionIndex,
    };
    turn = { ...turn, storedClientContext };
    step.session = setTurnClientContextState(step.session, storedClientContext);
  }
  if (!hasUnansweredToolCall(messages)) {
    const taskContext = await appendTaskContext({
      messages,
      session: step.session,
      tools: step.config.tools,
    });
    step.session = taskContext.session;
    // A turn a task's result starts brings no input of its own: what eve adds for the turn
    // sits ahead of the results instead.
    messages.push(
      ...taskContext.messages.map((message) =>
        message.role === "user" ? anchorToTurn(message, turn.turnId) : message,
      ),
    );
  }
  return { messages, turn };
}

/**
 * The turn's input joins history before the model call, so a call that fails leaves it there, and
 * the prompt the call reads. The client's context keeps the position it takes here.
 */
export async function commitTurnInput(step: Step, turn: TurnInput): Promise<Prompt> {
  const settled = await settleHistory(step, turn);
  const messages = placeTurnInput(step, settled.messages, settled.turn);
  step.session = changeHistory(step.session, { extend: messages });
  return {
    clientContext: getTurnClientContextState(step.session.state, turn.turnId),
    messages: [...step.session.history],
  };
}

/**
 * The prompt the session's dynamic values are evaluated with: history and the turn's input,
 * without the task results and the client context's position a prompt settles.
 */
export function previewPrompt(step: Step, turn: TurnInput): Prompt {
  const messages = validateHarnessModelMessages([...step.session.history]);
  return {
    clientContext: turnClientContext(messages, turn),
    messages: withTurnInput(messages, turn),
  };
}

/**
 * The turn's input after `messages`, past a tool-result boundary when they end in tool results.
 * The client's context takes its position here, and never joins the messages.
 */
function placeTurnInput(
  step: Step,
  messages: readonly HarnessModelMessage[],
  turn: TurnInput,
): HarnessModelMessage[] {
  const clientContext = turnClientContext(messages, turn);
  if (clientContext !== undefined) {
    step.session = setTurnClientContextState(step.session, clientContext);
  }
  return withTurnInput(messages, turn);
}

function turnClientContext(
  messages: readonly HarnessModelMessage[],
  turn: TurnInput,
): ClientContext | undefined {
  if (turn.clientContext === undefined) return turn.storedClientContext;
  return {
    insertionIndex: turn.storedClientContext?.insertionIndex ?? messages.length,
    messages: turn.clientContext,
    turnId: turn.turnId,
  };
}

function withTurnInput(
  messages: readonly HarnessModelMessage[],
  turn: TurnInput,
): HarnessModelMessage[] {
  return [
    ...messages,
    ...(followsToolResults(messages) ? followingToolResults(turn) : turn.messages),
  ];
}

/** `messages`, the prompt's by default, with the client's context at its position. */
export function withClientContext(
  prompt: Prompt,
  messages: readonly HarnessModelMessage[] = prompt.messages,
): HarnessModelMessage[] {
  const { clientContext } = prompt;
  if (clientContext === undefined || clientContext.messages.length === 0) return [...messages];
  const insertionIndex = Math.min(Math.max(0, clientContext.insertionIndex), messages.length);
  return [
    ...messages.slice(0, insertionIndex),
    ...clientContext.messages.map((content) =>
      createFrameworkUserMessage("context.instruction", content),
    ),
    ...messages.slice(insertionIndex),
  ];
}

/** The prompt as the model reads it: with the client's context. */
export function projectPrompt(prompt: Prompt): HarnessModelMessage[] {
  return validateHarnessModelMessages(normalizeModelMessages(withClientContext(prompt)));
}

/**
 * Compaction rewrote the durable messages: the client's context keeps its distance from the end,
 * so it stays after the turn's input.
 */
export function compactPrompt(step: Step, prompt: Prompt, messages: HarnessModelMessage[]): void {
  const { clientContext } = prompt;
  if (clientContext !== undefined) {
    const tail = Math.max(0, prompt.messages.length - clientContext.insertionIndex);
    prompt.clientContext = {
      ...clientContext,
      insertionIndex: Math.max(0, messages.length - tail),
    };
    step.session = setTurnClientContextState(step.session, prompt.clientContext);
  }
  prompt.messages = messages;
}
