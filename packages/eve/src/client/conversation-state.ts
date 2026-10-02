import type { EveAuthorizationPart, EveMessageData } from "#client/message-reducer-types.js";
import type {
  SessionInput,
  SessionProjection,
  SessionTask,
  SessionTaskCall,
  SessionTurn,
} from "#protocol/session-projection.js";
import { openSignIns } from "#protocol/session-projection.js";

export type ConversationTurn = SessionTurn;
export type ConversationInput = SessionInput;
/** One call that started or reached a task, settled by its `task.settled`. */
export type ConversationTaskCall = SessionTaskCall;
export type ConversationTask = SessionTask;

export type AgentObservation =
  | { readonly status: "not-followed" }
  | { readonly status: "following"; readonly conversation: ConversationState }
  /** Every call so far has shown its content; a later call to the task resumes following. */
  | { readonly status: "idle"; readonly conversation: ConversationState }
  | {
      /** The stream failed; this does not mean the agent failed. */
      readonly status: "unavailable";
      readonly conversation?: ConversationState;
    };

/** A session a run opened with `ctx.agent`, as its `agent.started` announced it. */
export interface ConversationAgentSession {
  readonly sessionId: string;
  readonly name: string;
  /** The call whose invocation opened the session. */
  readonly callId: string;
  readonly turnId: string;
  /** The task whose run opened the session; absent when an `execute` call opened it. */
  readonly taskId?: string;
  readonly observation: AgentObservation;
}

/**
 * Renderable conversation state: the message list plus the session projection every reader
 * shares. Root and agent-session input IDs occupy separate scopes.
 */
export interface ConversationState extends EveMessageData, SessionProjection {
  /** Sessions opened by this session's runs, by session ID. */
  readonly agents: Readonly<Record<string, ConversationAgentSession>>;
}

/** Inputs awaiting an answer, including requests introduced in earlier turns. */
export function openConversationInputs(state: ConversationState): readonly ConversationInput[] {
  return Object.values(state.inputs).filter((input) => input.status === "open");
}

/** Authorization attempts remain visible across turns, including parked callbacks. */
export function conversationAuthorizations(
  state: ConversationState,
): readonly EveAuthorizationPart[] {
  return state.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.filter((part): part is EveAuthorizationPart => part.type === "authorization")
      : [],
  );
}

/** A sign-in the session still waits on, which resumes its work when the callback arrives. */
export function hasPendingAuthorizations(state: ConversationState): boolean {
  return openSignIns(state).some((attempt) => attempt.awaitsCallback === true);
}

/**
 * The agent task whose calls a session receives, when the session is that agent's own. eve's agent
 * tools send each call as one message, in call order, which is what lets a client attribute the
 * session's turns to calls. A session an authored tool opens with `ctx.agent` has no such task.
 */
export function agentToolTask(
  state: ConversationState,
  agent: ConversationAgentSession,
): ConversationTask | undefined {
  const task = agent.taskId === undefined ? undefined : state.tasks[agent.taskId];
  return task?.kind === "agent" ? task : undefined;
}

/** The session an agent tool forwards its task's calls to. */
export function agentToolSession(
  state: ConversationState,
  task: ConversationTask,
): ConversationAgentSession | undefined {
  return Object.values(state.agents).find(
    (agent) => agentToolTask(state, agent)?.taskId === task.taskId,
  );
}

/**
 * Whether a followed agent tool session has shown everything its task's calls produced so far:
 * no call is working, the session has no open turn, question, or sign-in, and every completed call's
 * message has arrived. The last check covers a child stream that lags the root stream.
 */
export function isAgentSessionCaughtUp(
  state: ConversationState,
  agent: ConversationAgentSession,
): boolean {
  if (agent.observation.status !== "following" && agent.observation.status !== "idle") {
    return false;
  }
  const task = agentToolTask(state, agent);
  if (task === undefined) return false;
  const calls = Object.values(task.calls);
  if (calls.some((call) => call.status === "working")) return false;
  const child = agent.observation.conversation;
  if (child.activeTurnId !== undefined) return false;
  if (Object.values(child.inputs).some((input) => input.status !== "settled")) return false;
  if (hasPendingAuthorizations(child)) return false;
  const received = child.messages.filter((message) => message.role === "user").length;
  return received >= calls.filter((call) => call.status === "completed").length;
}

/**
 * Attributes an agent tool session's turns to the calls that produced them. The k-th message the
 * session received came from the task's k-th call; a turn without a message of its own, such as
 * one resumed after an approval, continues the previous call. A call whose message joined a
 * running turn owns no turn.
 */
export function agentCallTurns(
  task: ConversationTask,
  conversation: ConversationState,
): ReadonlyMap<string, readonly string[]> {
  const callIds = Object.keys(task.calls);
  const owners = new Map<string, string>();
  let index = 0;
  for (const message of conversation.messages) {
    if (message.role !== "user") continue;
    const callId = callIds[index++];
    const turnId = message.metadata?.turnId;
    if (callId !== undefined && turnId !== undefined && !owners.has(turnId)) {
      owners.set(turnId, callId);
    }
  }
  const turns = new Map<string, string[]>(callIds.map((callId) => [callId, []]));
  let owner: string | undefined;
  for (const turnId of Object.keys(conversation.turns)) {
    owner = owners.get(turnId) ?? owner;
    if (owner !== undefined) turns.get(owner)?.push(turnId);
  }
  return turns;
}

/**
 * Whether a call's content may still arrive on its agent tool session: one of the call's turns is
 * still open there, or the call completed before its message reached the session.
 */
export function isAgentCallContentPending(
  task: ConversationTask,
  call: ConversationTaskCall,
  conversation: ConversationState,
): boolean {
  const turnIds = agentCallTurns(task, conversation).get(call.callId) ?? [];
  const { activeTurnId } = conversation;
  if (activeTurnId !== undefined && turnIds.includes(activeTurnId)) return true;
  if (call.status !== "completed") return false;
  const received = conversation.messages.filter((message) => message.role === "user").length;
  return received <= Object.keys(task.calls).indexOf(call.callId);
}
