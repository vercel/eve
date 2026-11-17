import { stepCatalog } from "#definitions/step.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { appendTaskContext } from "#execution/tasks/model-step.js";
import {
  anchorToTurn,
  createFrameworkUserMessage,
  followsToolResults,
  type HarnessModelMessage,
  normalizeModelMessages,
  turnAnchorOf,
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

export interface Prompt {
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
      tools: await stepCatalog(step),
    });
    session = taskContext.session;
    messages.push(
      ...taskContext.messages.map((message) =>
        message.role === "user" ? anchorToTurn(message, turn.turnId) : message,
      ),
    );
  }
  return { messages, session, turn };
}

export function commitTurnInput(step: Step, prepared: PreparedPrompt): Prompt {
  step.session = prepared.session;
  if (prepared.clientContext !== undefined) {
    step.session = setTurnClientContextState(step.session, prepared.clientContext);
  }
  step.session = changeHistory(step.session, { extend: prepared.messages });
  return {
    clientContext: getTurnClientContextState(step.session.state, prepared.turn.turnId),
    messages: [...step.session.history],
  };
}

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

export function withClientContext(
  prompt: Prompt,
  messages: readonly HarnessModelMessage[] = prompt.messages,
): HarnessModelMessage[] {
  const { clientContext } = prompt;
  if (clientContext === undefined || clientContext.messages.length === 0) return [...messages];
  let insertionIndex = Math.min(Math.max(0, clientContext.insertionIndex), messages.length);
  while (insertionIndex < messages.length && isAnnouncement(messages[insertionIndex]!)) {
    insertionIndex += 1;
  }
  return [
    ...messages.slice(0, insertionIndex),
    ...clientContext.messages.map((content) =>
      createFrameworkUserMessage("context.instruction", content),
    ),
    ...messages.slice(insertionIndex),
  ];
}

function isAnnouncement(message: HarnessModelMessage): boolean {
  return (
    message.role === "user" &&
    (message.kind === "context.state" || message.kind === "context.instruction") &&
    turnAnchorOf(message) === undefined
  );
}

export function projectPrompt(prompt: Prompt): HarnessModelMessage[] {
  return validateHarnessModelMessages(normalizeModelMessages(withClientContext(prompt)));
}

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
