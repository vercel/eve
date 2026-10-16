import type { EveMessage } from "#client/message-types.js";
import type {
  CallRow,
  DeliveryRow,
  SessionView,
  SessionPreviews,
  TaskRow,
} from "#protocol/session-projection/tables.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import { openSignIns } from "#protocol/session-reader.js";

export type AgentObservation =
  | { readonly status: "not-followed" }
  | { readonly status: "following" | "idle"; readonly conversation: ConversationState }
  | { readonly status: "unavailable"; readonly conversation?: ConversationState };

/** A child session linked by the root's `child.opened`, with its independent observation state. */
export interface ConversationAgentSession {
  readonly sessionId: string;
  readonly name: string;
  readonly callId: string;
  readonly turnId: string;
  readonly taskId?: string;
  readonly observation: AgentObservation;
}

/** Lifecycle stays in its native tables; only messages and local answers are projected for display. */
export interface ConversationState {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
  readonly messages: readonly EveMessage[];
  readonly agents: Readonly<Record<string, ConversationAgentSession>>;
}

export function hasPendingAuthorizations(state: ConversationState): boolean {
  return openSignIns(state.view).some((row) => row.request.signIn?.callbackUrl !== undefined);
}

export function agentToolTask(
  state: ConversationState,
  agent: ConversationAgentSession,
): TaskRow | undefined {
  const task = agent.taskId === undefined ? undefined : state.view.tasks[agent.taskId];
  return task?.kind === "agent" ? task : undefined;
}

export function agentToolSession(
  state: ConversationState,
  task: TaskRow,
): ConversationAgentSession | undefined {
  return Object.values(state.agents).find(
    (agent) => agentToolTask(state, agent)?.taskId === task.taskId,
  );
}

/** Direct model calls served by this task, in call order. */
export function taskCalls(view: SessionView, taskId: string): readonly CallRow[] {
  return Object.values(view.calls).filter((call) => call.taskId === taskId);
}

/** Root completion can precede the child's last committed line. */
export function isAgentSessionCaughtUp(
  state: ConversationState,
  agent: ConversationAgentSession,
): boolean {
  if (agent.observation.status !== "following" && agent.observation.status !== "idle") return false;
  const task = agentToolTask(state, agent);
  if (task === undefined) return false;
  const calls = taskCalls(state.view, task.taskId);
  if (calls.some((call) => call.status !== "settled")) return false;
  const child = agent.observation.conversation;
  if (activeTurn(child.view) !== undefined) return false;
  if (Object.values(child.view.interactions).some((input) => input.status !== "settled"))
    return false;
  if (hasPendingAuthorizations(child)) return false;
  return !calls.some((call) => isAgentCallContentPending(calls, call, child));
}

/** Named deliveries are authoritative; unnamed remote sessions retain their in-order mapping. */
function callDeliveries(
  calls: readonly CallRow[],
  conversation: ConversationState,
): ReadonlyMap<string, readonly DeliveryRow[]> | undefined {
  const rows = Object.values(conversation.view.deliveries)
    .filter((row) => row.source !== undefined && "channel" in row.source)
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const named = rows.flatMap((row) => {
    const callId =
      row.source !== undefined && "caller" in row.source ? row.source.caller?.callId : undefined;
    return callId === undefined ? [] : [{ callId, row }];
  });
  if (named.length === 0) return undefined;
  const byCall = new Map<string, DeliveryRow[]>(calls.map(({ callId }) => [callId, []]));
  for (const { callId, row } of named) byCall.get(callId)?.push(row);
  return byCall;
}

/** Each child turn belongs to the call whose delivery it consumed first; resumed turns retain that owner. */
export function agentCallTurns(
  calls: readonly CallRow[],
  conversation: ConversationState,
): ReadonlyMap<string, readonly string[]> {
  const callIds = calls.map((call) => call.callId);
  const owners = new Map<string, string>();
  const byCall = callDeliveries(calls, conversation);
  if (byCall === undefined) {
    let index = 0;
    for (const message of conversation.messages) {
      if (message.role !== "user") continue;
      const callId = callIds[index++];
      const turnId = message.metadata?.turnId;
      if (callId !== undefined && turnId !== undefined && !owners.has(turnId))
        owners.set(turnId, callId);
    }
  } else {
    const consumed = [...byCall].flatMap(([callId, rows]) =>
      rows.flatMap((row) =>
        row.turnId === undefined || row.consumedAt === undefined
          ? []
          : [{ at: row.consumedAt, callId, turnId: row.turnId }],
      ),
    );
    for (const { callId, turnId } of consumed.sort((a, b) => a.at - b.at)) {
      if (!owners.has(turnId)) owners.set(turnId, callId);
    }
  }
  const turns = new Map<string, string[]>(callIds.map((callId) => [callId, []]));
  let owner: string | undefined;
  for (const turnId of Object.keys(conversation.view.turns)) {
    owner = owners.get(turnId) ?? owner;
    if (owner !== undefined) turns.get(owner)?.push(turnId);
  }
  return turns;
}

/** A settled root call still waits for its exact child delivery's content and settlement. */
export function isAgentCallContentPending(
  calls: readonly CallRow[],
  call: CallRow,
  conversation: ConversationState,
): boolean {
  const turnIds = agentCallTurns(calls, conversation).get(call.callId) ?? [];
  const turnId = activeTurn(conversation.view)?.turnId;
  if (turnId !== undefined && turnIds.includes(turnId)) return true;
  const byCall = callDeliveries(calls, conversation);
  if (byCall !== undefined) {
    const rows = byCall.get(call.callId) ?? [];
    if (rows.some((row) => row.status !== "settled")) return true;
    return call.outcome === "completed" && rows.length === 0;
  }
  if (call.outcome !== "completed") return false;
  const received = conversation.messages.filter((message) => message.role === "user").length;
  return received <= calls.findIndex((candidate) => candidate.callId === call.callId);
}
