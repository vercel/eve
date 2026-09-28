import type {
  AgentObservation,
  ConversationAgentSession,
  ConversationInput,
  ConversationState,
  ConversationTask,
  ConversationTurn,
} from "#client/conversation-state.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";

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
  return { messages: [], turns: {}, inputs: {}, tasks: {}, agents: {} };
}

function updateTurn(
  state: ConversationState,
  turnId: string,
  update: (turn: ConversationTurn) => ConversationTurn,
): ConversationState {
  const turn = state.turns[turnId];
  if (turn === undefined) return state;
  const next = update(turn);
  return next === turn ? state : { ...state, turns: { ...state.turns, [turnId]: next } };
}

function updateTask(
  state: ConversationState,
  taskId: string,
  update: (task: ConversationTask) => ConversationTask,
): ConversationState {
  const task = state.tasks[taskId];
  if (task === undefined) return state;
  const next = update(task);
  return next === task ? state : { ...state, tasks: { ...state.tasks, [taskId]: next } };
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

/** Applies lifecycle identity and closure to an already projected message state. */
function reduceConversationLifecycle(
  state: ConversationState,
  event: EveAgentReducerEvent,
): ConversationState {
  switch (event.type) {
    case "turn.started":
      return {
        ...state,
        activeTurnId: event.data.turnId,
        turns: {
          ...state.turns,
          [event.data.turnId]: { turnId: event.data.turnId, status: "active" },
        },
      };
    case "turn.waiting":
      return updateTurn(state, event.data.turnId, (turn) =>
        turn.status === "active" && !turn.waiting ? { ...turn, waiting: true } : turn,
      );
    case "step.started":
      return updateTurn(state, event.data.turnId, (turn) =>
        turn.waiting ? { turnId: turn.turnId, status: turn.status } : turn,
      );
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed": {
      const { turnId } = event.data;
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: {
          ...state.turns,
          [turnId]: {
            turnId,
            status:
              event.type === "turn.completed"
                ? "completed"
                : event.type === "turn.failed"
                  ? "failed"
                  : "cancelled",
          },
        },
      };
    }
    // Only a turn's end reaches a session boundary, so no turn stays open across one.
    case "session.waiting":
    case "session.completed":
    case "session.failed":
      return state.activeTurnId === undefined ? state : { ...state, activeTurnId: undefined };
    case "task.started": {
      const { callId, name, taskId, turnId } = event.data;
      const task = state.tasks[taskId] ?? { taskId, name, calls: {} };
      if (task.calls[callId] !== undefined) return state;
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [taskId]: {
            ...task,
            calls: { ...task.calls, [callId]: { callId, turnId, status: "working" } },
          },
        },
      };
    }
    case "task.settled": {
      const { callId, error, output, status, taskId } = event.data;
      return updateTask(state, taskId, (task) => {
        const call = task.calls[callId];
        if (call === undefined || call.status !== "working") return task;
        const settled = { callId, turnId: call.turnId, status };
        return {
          ...task,
          calls: {
            ...task.calls,
            [callId]:
              status === "completed" && output !== undefined
                ? { ...settled, output }
                : status === "failed" && error !== undefined
                  ? { ...settled, error }
                  : settled,
          },
        };
      });
    }
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
      return { ...state, agents: { ...state.agents, [sessionId]: agent } };
    }
    case "input.requested": {
      const inputs = { ...state.inputs };
      for (const request of event.data.requests) {
        if (inputs[request.requestId] !== undefined) continue;
        const input: Mutable<ConversationInput> = {
          request,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          status: "open",
        };
        if (event.data.taskId !== undefined) input.taskId = event.data.taskId;
        inputs[request.requestId] = input;
      }
      return { ...state, inputs };
    }
    case "client.input.responded": {
      const inputs = { ...state.inputs };
      for (const response of event.data.responses) {
        const current = inputs[response.requestId];
        if (current?.status !== "open") continue;
        inputs[response.requestId] = { ...current, response, status: "responded" };
      }
      return { ...state, inputs };
    }
    case "approval.candidate": {
      const current = state.inputs[event.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      if (event.data.outcome === "pending") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [event.data.requestId]: { ...current, status: "open", response: undefined },
        },
      };
    }
    case "approval.settled": {
      const current = state.inputs[event.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [event.data.requestId]: { ...current, status: "settled", outcome: event.data.outcome },
        },
      };
    }
    case "input.resolved": {
      const inputs = { ...state.inputs };
      for (const resolution of event.data.resolutions) {
        const current = inputs[resolution.requestId];
        if (current === undefined || current.status === "settled") continue;
        inputs[resolution.requestId] = {
          ...current,
          status: "settled",
          outcome: resolution.outcome,
          response: resolution.response ?? current.response,
        };
      }
      return { ...state, inputs };
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
    default: {
      const projected = messageReducer.reduce(state, event);
      return reduceConversationLifecycle({ ...state, ...projected }, event);
    }
  }
}

/** The canonical conversation's reducer, which also folds in followed agent sessions. */
export const canonicalConversationReducer = {
  initial: initialConversationState,
  reduce: reduceConversation,
};

export const conversationReducer: EveAgentReducer<ConversationState> = canonicalConversationReducer;
