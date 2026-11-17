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
  return {
    clientContext: getTurnClientContextState(step.session.state, turn.turnId),
    messages: built.messages,
  };
}

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
      tools: await stepCatalog(step),
    });
    step.session = taskContext.session;
    messages.push(
      ...taskContext.messages.map((message) =>
        message.role === "user" ? anchorToTurn(message, turn.turnId) : message,
      ),
    );
  }
  return { messages, turn };
}

export async function commitTurnInput(step: Step, turn: TurnInput): Promise<Prompt> {
  const settled = await settleHistory(step, turn);
  const messages = placeTurnInput(step, settled.messages, settled.turn);
  step.session = changeHistory(step.session, { extend: messages });
  return {
    clientContext: getTurnClientContextState(step.session.state, turn.turnId),
    messages: [...step.session.history],
  };
}

export function previewPrompt(step: Step, turn: TurnInput): Prompt {
  const messages = validateHarnessModelMessages([...step.session.history]);
  return {
    clientContext: turnClientContext(messages, turn),
    messages: withTurnInput(messages, turn),
  };
}

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
