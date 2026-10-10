import {
  conversationProjection,
  withConversationProjection,
} from "#client/conversation-projection.js";
import type {
  AgentObservation,
  ConversationAgentSession,
  ConversationState,
} from "#client/conversation-state.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { initialSessionProjection } from "#protocol/session-projection.js";

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
      readonly data: { readonly event: MessageStreamEvent; readonly sessionId: string };
      readonly type: "client.agent.observed";
    };

export type ConversationEvent = EveAgentReducerEvent | ClientAgentEvent;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function initialConversationState(): ConversationState {
  return withConversationProjection(
    { turns: {}, inputs: {}, tasks: {}, messages: [], agents: {} },
    initialSessionProjection(),
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
    case "agent.started": {
      const { callId, name, sessionId, taskId, turnId } = event.data;
      if (state.agents[sessionId] !== undefined) return state;
      const agent: Mutable<ConversationAgentSession> = {
        sessionId,
        name,
        callId,
        turnId,
        observation: { status: "not-followed" },
      };
      if (taskId !== undefined) agent.taskId = taskId;
      return withConversationProjection(
        { ...state, agents: { ...state.agents, [sessionId]: agent } },
        conversationProjection(state),
      );
    }
    // An answer this client sent shows as responded until the stream settles it.
    case "client.input.responded": {
      const inputs = { ...state.inputs };
      for (const response of event.data.responses) {
        const current = inputs[response.requestId];
        if (current?.status !== "open") continue;
        inputs[response.requestId] = { ...current, response, status: "responded" };
      }
      const projection = conversationProjection(state);
      const projectedInputs = { ...projection.inputs };
      for (const response of event.data.responses) {
        const current = projectedInputs[response.requestId];
        if (current?.status === "open")
          projectedInputs[response.requestId] = { ...current, response, status: "responded" };
      }
      return withConversationProjection(
        { ...state, inputs },
        { ...projection, inputs: projectedInputs },
      );
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
    ? withConversationProjection(next, conversationProjection(state))
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
      const projection = conversationProjection(messages);
      const { activeTurnId: _activeTurnId, ...rest } = state;
      const { activeTurnId: _messageTurnId, ...messageData } = messages as ConversationState;
      const conversation: Mutable<ConversationState> = {
        ...rest,
        ...messageData,
        turns: Object.fromEntries(
          Object.entries(projection.turns).map(([id, turn]) => {
            const { turnId, status, waiting } = turn;
            const publicTurn: Mutable<ConversationState["turns"][string]> = { turnId, status };
            if (waiting !== undefined) publicTurn.waiting = waiting;
            return [id, publicTurn];
          }),
        ),
        inputs: Object.fromEntries(
          Object.entries(projection.inputs).map(([id, input]) => {
            const { sequence: _sequence, callId: _callId, ...publicInput } = input;
            return [id, publicInput];
          }),
        ),
        tasks: projection.tasks,
      };
      if (projection.activeTurnId !== undefined)
        conversation.activeTurnId = projection.activeTurnId;
      return reduceConversationLifecycle(
        withConversationProjection(conversation, projection),
        event,
      );
  }
}

/** The canonical conversation's reducer, which also folds in followed agent sessions. */
export const canonicalConversationReducer = {
  initial: initialConversationState,
  reduce: reduceConversation,
};

export const conversationReducer: EveAgentReducer<ConversationState> = canonicalConversationReducer;
