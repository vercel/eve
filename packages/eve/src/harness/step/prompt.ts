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

/** `pending` is the transcript the step resumes, which follows the turn's preamble in history. */
export async function buildPrompt(
  step: Step,
  turn: TurnInput,
  pending: readonly HarnessModelMessage[],
): Promise<Prompt> {
  const messages = validateHarnessModelMessages([...step.session.history, ...pending]);
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

  let clientContext = turn.storedClientContext;
  if (turn.clientContext !== undefined) {
    clientContext = {
      insertionIndex: turn.storedClientContext?.insertionIndex ?? messages.length,
      messages: turn.clientContext,
      turnId: turn.turnId,
    };
  }
  if (clientContext !== undefined) {
    step.session = setTurnClientContextState(step.session, clientContext);
  }
  return {
    clientContext,
    messages: [
      ...messages,
      ...(followsToolResults(messages) ? followingToolResults(turn) : turn.messages),
    ],
  };
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
