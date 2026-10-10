import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  conversationLedger,
  type ConversationLedger,
  emptyConversationLedger,
  withConversationLedger,
} from "#client/conversation-projection.js";
import type {
  AgentObservation,
  ConversationAgentSession,
  ConversationInput,
  ConversationState,
} from "#client/conversation-state.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import {
  activeTurnId,
  readerInput,
  readerInputs,
  readerTaskCall,
  readerTaskRow,
  readerTurn,
} from "#protocol/session-reader.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * Transport facts about followed agent sessions. Only the canonical conversation receives them;
 * custom reducers see their results in `conversation.agents`.
 */
export type ClientAgentEvent =
  | {
      readonly data: { readonly sessionId: string };
      readonly type: "client.agent.following" | "client.agent.idle" | "client.agent.unavailable";
    }
  | {
      readonly data: { readonly event: SessionStreamEvent; readonly sessionId: string };
      readonly type: "client.agent.observed";
    };

export type ConversationEvent = EveAgentReducerEvent | ClientAgentEvent;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function initialConversationState(): ConversationState {
  return withConversationLedger(
    { turns: {}, inputs: {}, tasks: {}, messages: [], agents: {} },
    emptyConversationLedger(),
  );
}

function updateObservation(
  state: ConversationState,
  sessionId: string,
  update: (observation: AgentObservation) => AgentObservation,
): ConversationState {
  const agent = state.agents[sessionId];
  if (agent === undefined) return state;
  const observation = update(agent.observation);
  if (observation === agent.observation) return state;
  return { ...state, agents: { ...state.agents, [sessionId]: { ...agent, observation } } };
}

function observedConversation(observation: AgentObservation): ConversationState | undefined {
  return observation.status === "not-followed" ? undefined : observation.conversation;
}

/** Records the agent sessions the conversation's runs open, and the answers this client sent. */
function reduceConversationLifecycle(
  state: ConversationState,
  event: EveAgentReducerEvent,
): ConversationState {
  switch (event.type) {
    case "child.opened": {
      const { name, owner, sessionId } = event.data;
      const turnId = event.scope?.turnId;
      const taskId = event.scope?.taskId ?? ("taskId" in owner ? owner.taskId : undefined);
      const callId = "callId" in owner ? owner.callId : undefined;
      if (state.agents[sessionId] !== undefined || callId === undefined || turnId === undefined)
        return state;
      const agent: Mutable<ConversationAgentSession> = {
        sessionId,
        name,
        callId,
        turnId,
        observation: { status: "not-followed" },
      };
      if (taskId !== undefined) agent.taskId = taskId;
      return withConversationLedger(
        { ...state, agents: { ...state.agents, [sessionId]: agent } },
        conversationLedger(state),
      );
    }
    // An answer this client sent shows as responded until the stream settles it.
    case "client.input.responded": {
      const ledger = conversationLedger(state);
      const responded = { ...ledger.responded };
      for (const response of event.data.responses) {
        if (state.inputs[response.requestId]?.status === "open")
          responded[response.requestId] = response;
      }
      const next = { ...ledger, responded };
      return withConversationLedger({ ...state, inputs: inputsOf(next) }, next);
    }
    default:
      return state;
  }
}

const messageReducer = defaultMessageReducer();

/** Pure reduction of accepted root and agent-session observations; followers own transport. */
export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  const next = reduceConversationEvent(state, event);
  return event.type.startsWith("client.agent.")
    ? withConversationLedger(next, conversationLedger(state))
    : next;
}

function reduceConversationEvent(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case "client.agent.following":
      return updateObservation(state, event.data.sessionId, (observation) =>
        observation.status === "following"
          ? observation
          : {
              status: "following",
              conversation: observedConversation(observation) ?? initialConversationState(),
            },
      );
    case "client.agent.observed":
      return updateObservation(state, event.data.sessionId, (observation) =>
        observation.status === "following"
          ? {
              status: "following",
              conversation: reduceConversation(observation.conversation, event.data.event),
            }
          : observation,
      );
    case "client.agent.idle":
      return updateObservation(state, event.data.sessionId, (observation) =>
        observation.status === "following"
          ? { status: "idle", conversation: observation.conversation }
          : observation,
      );
    case "client.agent.unavailable":
      return updateObservation(state, event.data.sessionId, (observation) => {
        const conversation = observedConversation(observation);
        return conversation === undefined
          ? { status: "unavailable" }
          : { status: "unavailable", conversation };
      });
    default:
      const messages = messageReducer.reduce(state, event);
      const ledger = conversationLedger(messages);
      const { activeTurnId: _activeTurnId, ...rest } = state;
      const { activeTurnId: _messageTurnId, ...messageData } = messages as ConversationState;
      // Only the records an event's fact touches change, so a long session's reload stays linear.
      const conversation: Mutable<ConversationState> = {
        ...rest,
        ...messageData,
        inputs: nextInputs(state.inputs, ledger, event),
        tasks: nextTasks(state.tasks, ledger.view, event),
        turns: nextTurns(state.turns, ledger.view, event),
      };
      const active = activeTurnId(ledger.view);
      if (active !== undefined) conversation.activeTurnId = active;
      return reduceConversationLifecycle(withConversationLedger(conversation, ledger), event);
  }
}

/** A request as a client shows it: an answer this client sent reads as responded. */
function inputOf(ledger: ConversationLedger, requestId: string): ConversationInput | undefined {
  const input = readerInput(ledger.view, requestId);
  if (input === undefined) return undefined;
  const { callId: _callId, pendingResponseIds: _pending, ...shown } = input;
  const response = ledger.responded[requestId];
  return response !== undefined && input.status === "open"
    ? { ...shown, response, status: "responded" }
    : shown;
}

/** Every request as a client shows it. */
function inputsOf(ledger: ConversationLedger): Readonly<Record<string, ConversationInput>> {
  const inputs: Record<string, ConversationInput> = {};
  for (const requestId of Object.keys(readerInputs(ledger.view))) {
    const input = inputOf(ledger, requestId);
    if (input !== undefined) inputs[requestId] = input;
  }
  return inputs;
}

type FactData = {
  readonly callId?: string;
  readonly interactionId?: string;
  readonly responseId?: string;
  readonly taskId?: string;
  readonly turnId?: string;
};

function factData(event: ConversationEvent): FactData {
  return "data" in event && event.data !== null && typeof event.data === "object"
    ? (event.data as FactData)
    : {};
}

function nextTurns(
  turns: ConversationState["turns"],
  view: SessionView,
  event: ConversationEvent,
): ConversationState["turns"] {
  const { turnId } = factData(event);
  if (!event.type.startsWith("turn.") || turnId === undefined) return turns;
  const turn = readerTurn(view, turnId);
  return turn === undefined ? turns : { ...turns, [turnId]: turn };
}

function nextInputs(
  inputs: ConversationState["inputs"],
  ledger: ConversationLedger,
  event: ConversationEvent,
): ConversationState["inputs"] {
  const data = factData(event);
  const requestId = event.type.startsWith("interaction.")
    ? data.interactionId
    : event.type.startsWith("response.")
      ? (data.interactionId ??
        (data.responseId === undefined
          ? undefined
          : ledger.view.responses[data.responseId]?.interactionId))
      : undefined;
  if (requestId === undefined) return inputs;
  const input = inputOf(ledger, requestId);
  return input === undefined ? inputs : { ...inputs, [requestId]: input };
}

function nextTasks(
  tasks: ConversationState["tasks"],
  view: SessionView,
  event: ConversationEvent,
): ConversationState["tasks"] {
  const data = factData(event);
  if (event.type === "task.started" && data.taskId !== undefined) {
    if (tasks[data.taskId] !== undefined) return tasks;
    const task = readerTaskRow(view, data.taskId);
    return task === undefined ? tasks : { ...tasks, [data.taskId]: task };
  }
  if ((event.type !== "call.started" && event.type !== "call.settled") || !data.callId)
    return tasks;
  const taskId = view.calls[data.callId]?.taskId;
  const task = taskId === undefined ? undefined : tasks[taskId];
  const call = readerTaskCall(view, data.callId);
  if (taskId === undefined || task === undefined || call === undefined) return tasks;
  return { ...tasks, [taskId]: { ...task, calls: { ...task.calls, [data.callId]: call } } };
}

/** The canonical conversation's reducer, which also folds in followed agent sessions. */
export const canonicalConversationReducer = {
  initial: initialConversationState,
  reduce: reduceConversation,
};

export const conversationReducer: EveAgentReducer<ConversationState> = canonicalConversationReducer;
