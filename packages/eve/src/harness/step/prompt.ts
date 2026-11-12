import { stepCatalog } from "#definitions/step.js";
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
import { rememberSender } from "#harness/sender-line.js";
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
  step.session = built.session;
  return {
    clientContext: getTurnClientContextState(step.session.state, turn.turnId),
    messages: built.messages,
  };
}

/**
 * History repaired and with the task results the step delivers, the session that records the
 * delivery, and the turn as the repair left its client context's position. The step's session is
 * left as it was, so a preview can read the same prompt without delivering anything.
 */
async function settleHistory(
  step: Step,
  turn: TurnInput,
): Promise<{
  readonly messages: HarnessModelMessage[];
  readonly session: Step["session"];
  readonly turn: TurnInput;
}> {
  const repaired = repairToolHistory({
    endsRequest: turn.messages.length === 0,
    messages: step.session.history,
    insertionIndex: turn.storedClientContext?.insertionIndex,
  });
  let session = changeHistory(step.session, { repaired: repaired.messages });
  // Its own copy: task results join it below.
  const messages = [...session.history];
  if (turn.storedClientContext !== undefined && repaired.insertionIndex !== undefined) {
    const storedClientContext = {
      ...turn.storedClientContext,
      insertionIndex: repaired.insertionIndex,
    };
    turn = { ...turn, storedClientContext };
    session = setTurnClientContextState(session, storedClientContext);
  }
  if (!hasUnansweredToolCall(messages)) {
    const taskContext = await appendTaskContext({
      messages,
      session,
      // Dynamic values can read these results, so use the tools kept before evaluating them.
      tools: await stepCatalog(step),
    });
    session = taskContext.session;
    // A turn a task's result starts brings no input of its own: what eve adds for the turn
    // sits ahead of the results instead.
    messages.push(
      ...taskContext.messages.map((message) =>
        message.role === "user" ? anchorToTurn(message, turn.turnId) : message,
      ),
    );
  }
  return { messages, session, turn };
}

/**
 * Commits the prepared prompt only after dynamic evaluation succeeds, without projecting task
 * results again. A model call that fails leaves the turn's input in history.
 */
export function commitTurnInput(step: Step, prepared: PreparedPrompt): Prompt {
  step.session = prepared.session;
  if (prepared.clientContext !== undefined) {
    step.session = setTurnClientContextState(step.session, prepared.clientContext);
  }
  step.session = changeHistory(step.session, { extend: prepared.messages });
  const { sender } = prepared.turn;
  if (sender !== undefined) {
    step.session = rememberSender(step.session, sender, prepared.turn.turnId);
  }
  return {
    clientContext: getTurnClientContextState(step.session.state, prepared.turn.turnId),
    messages: [...step.session.history],
  };
}

/**
 * The prompt the session's dynamic values are evaluated with: the one the model call reads, with
 * the task results it delivers, without committing the turn's input or the delivery.
 */
export async function previewPrompt(step: Step, turn: TurnInput): Promise<PreparedPrompt> {
  const settled = await settleHistory(step, turn);
  const messages = validateHarnessModelMessages(settled.messages);
  return {
    ...settled,
    clientContext: turnClientContext(messages, settled.turn),
    messages: withTurnInput(messages, settled.turn),
  };
}

interface PreparedPrompt extends Prompt {
  readonly session: Step["session"];
  readonly turn: TurnInput;
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
