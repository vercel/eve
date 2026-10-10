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
import { activeTurnId, readerInputs, readerTasks, readerTurns } from "#protocol/session-reader.js";

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
      // Progress changes no table, so the derived records carry over.
      const unchanged = ledger.view === conversationLedger(state).view;
      const conversation: Mutable<ConversationState> = {
        ...rest,
        ...messageData,
        inputs: unchanged ? state.inputs : inputsOf(ledger),
        tasks: unchanged ? state.tasks : readerTasks(ledger.view),
        turns: unchanged ? state.turns : readerTurns(ledger.view),
      };
      const active = activeTurnId(ledger.view);
      if (active !== undefined) conversation.activeTurnId = active;
      return reduceConversationLifecycle(withConversationLedger(conversation, ledger), event);
  }
}

/** Requests as a client shows them: an answer this client sent reads as responded. */
function inputsOf(ledger: ConversationLedger): Readonly<Record<string, ConversationInput>> {
  const inputs: Record<string, ConversationInput> = {};
  for (const [requestId, input] of Object.entries(readerInputs(ledger.view))) {
    const { callId: _callId, pendingResponseIds: _pending, ...shown } = input;
    const response = ledger.responded[requestId];
    inputs[requestId] =
      response !== undefined && input.status === "open"
        ? { ...shown, response, status: "responded" }
        : shown;
  }
  return inputs;
}

/** The canonical conversation's reducer, which also folds in followed agent sessions. */
export const canonicalConversationReducer = {
  initial: initialConversationState,
  reduce: reduceConversation,
};

export const conversationReducer: EveAgentReducer<ConversationState> = canonicalConversationReducer;
