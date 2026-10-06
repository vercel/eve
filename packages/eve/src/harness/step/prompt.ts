import { appendTaskContext } from "#execution/tasks/model-step.js";
import {
  createFrameworkUserMessage,
  followsToolResults,
  type HarnessModelMessage,
  normalizeModelMessages,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { hasUnansweredToolCall } from "#harness/model-call/response.js";
import {
  getTurnClientContextState,
  setTurnClientContextState,
} from "#harness/turn-client-context.js";
import type { Step } from "./context.js";
import { followingToolResults, type TurnInput } from "./intake.js";

type ClientContext = NonNullable<ReturnType<typeof getTurnClientContextState>>;

/**
 * What the model reads this step: durable history, with the task results and notes the step
 * delivers and the turn's input, and the client's context for the turn, which keeps one position
 * across the turn's steps and never joins history.
 */
export interface Prompt {
  /** Durable messages. Compaction may rewrite them. */
  messages: HarnessModelMessage[];
  clientContext: ClientContext | undefined;
}

export async function buildPrompt(step: Step, turn: TurnInput): Promise<Prompt> {
  const messages = validateHarnessModelMessages([...step.session.history]);
  if (!hasUnansweredToolCall(messages)) {
    const taskContext = await appendTaskContext({
      messages,
      projectHistory: step.projectHistory,
      session: step.session,
      tools: step.config.tools,
    });
    step.session = taskContext.session;
    messages.push(...taskContext.messages);
  }

  const placed = placeTurnInput(step, messages, turn);
  return {
    clientContext: getTurnClientContextState(step.session.state, turn.turnId),
    messages: placed,
  };
}

/**
 * The prompt a step starts on while approved calls wait to run: history and the turn's input,
 * without the task results and the client context's position a prompt settles, which wait for
 * the prompt the model reads once the calls have run.
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
export function placeTurnInput(
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

/** The prompt as the model reads it: with the client's context, projected for its history view. */
export function projectPrompt(step: Step, prompt: Prompt): HarnessModelMessage[] {
  return validateHarnessModelMessages(
    normalizeModelMessages(step.projectHistory(withClientContext(prompt))),
  );
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
