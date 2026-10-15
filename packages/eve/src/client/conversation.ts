import type {
  AgentObservation,
  ConversationAgentSession,
  ConversationInteraction,
  ConversationState,
} from "#client/conversation-state.js";
import { assistantMessages, userMessage } from "#client/messages.js";
import type { EveMessage } from "#client/message-types.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  emptyPreviews,
  emptySessionView,
  foldReceivedEvent,
} from "#protocol/session-projection/fold.js";
import { activeTurn, runTurn } from "#protocol/session-projection/selectors.js";
import type { SessionPreviews, SessionView } from "#protocol/session-projection/tables.js";
import {
  callPlace,
  interaction,
  readerTasks,
  readerTurns,
  interactionPlace,
} from "#protocol/session-reader.js";
import type { Answer } from "#shared/input.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A message this client sent that eve hasn't consumed yet, or that failed to send. */
export interface LocalSubmission {
  readonly id: string;
  readonly message: string;
  /** The open turn a steering message joins, when known. */
  readonly turnId?: string;
  readonly error?: { readonly message: string };
}

type FollowStatus = Exclude<AgentObservation["status"], "not-followed">;

interface FollowedAgent {
  readonly status: FollowStatus;
  readonly conversation: Conversation;
}

const tablesKey = Symbol("eve.conversationTables");

/** The tables a conversation state derives from, for eve's own readers. */
export function conversationView(state: ConversationState): SessionView {
  return conversationTables(state).view;
}

/** The tables a conversation state derives from, with the previews of what is still streaming. */
export function conversationTables(state: ConversationState): {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
} {
  return (
    (state as { [tablesKey]?: Conversation })[tablesKey] ?? {
      previews: emptyPreviews(),
      view: emptySessionView(),
    }
  );
}

/**
 * One session as a client shows it: the shared tables its stream folds into, with the previews
 * of what is still streaming, and what this client did that the stream hasn't confirmed yet (the
 * messages it sent and the answers it gave). `state` derives the conversation from them.
 *
 * The tables fold in place, so a long session costs each event only what it changes, and `state`
 * rebuilds only the messages of the turns that changed since it was last read.
 */
export class Conversation {
  readonly view: SessionView = emptySessionView();
  readonly previews: SessionPreviews = emptyPreviews();
  #through: { readonly line: number; readonly index: number } | undefined;
  #responded: Readonly<Record<string, Answer>> = {};
  #submissions: readonly LocalSubmission[] = [];
  readonly #agents = new Map<string, FollowedAgent>();
  #messages = new Map<string, EveMessage>();
  readonly #users = new Map<string, EveMessage>();
  #changed: Set<string> | "all" = "all";
  #state: ConversationState | undefined;

  /** Folds one event of the session's stream; false when the tables already hold it. */
  observe(event: SessionStreamEvent): boolean {
    const position = event.meta?.position;
    const through = this.#through;
    if (
      position !== undefined &&
      through !== undefined &&
      (position.line < through.line ||
        (position.line === through.line && position.index <= through.index))
    )
      return false;
    if (position !== undefined) this.#through = position;
    foldReceivedEvent(this.view, event, this.previews);
    for (const turnId of touchedTurns(this.view, this.previews, event)) this.#touch(turnId);
    this.#forgetSettledAnswer(event);
    this.#state = undefined;
    return true;
  }

  /** Shows answers this client sent as responded until the stream settles them; returns their withdrawal. */
  answer(answers: readonly Answer[]): () => void {
    const added: Record<string, Answer> = {};
    for (const answer of answers) {
      if (this.view.interactions[answer.interactionId]?.status === "open")
        added[answer.interactionId] = answer;
    }
    this.#setResponded({ ...this.#responded, ...added });
    return () => {
      const responded = { ...this.#responded };
      for (const [interactionId, answer] of Object.entries(added)) {
        if (responded[interactionId] === answer) delete responded[interactionId];
      }
      this.#setResponded(responded);
    };
  }

  /** Shows, replaces, or removes the messages this client sent that eve hasn't consumed. */
  setSubmissions(submissions: readonly LocalSubmission[]): void {
    this.#submissions = submissions;
    this.#state = undefined;
  }

  get submissions(): readonly LocalSubmission[] {
    return this.#submissions;
  }

  /** Records how this client follows a session one of this session's calls opened. */
  follow(sessionId: string, status: FollowStatus): void {
    const followed = this.#agents.get(sessionId);
    if (followed?.status === status) return;
    this.#agents.set(sessionId, {
      conversation: followed?.conversation ?? new Conversation(),
      status,
    });
    this.#state = undefined;
  }

  /** Folds an event from a followed session's stream. */
  observeAgent(sessionId: string, event: SessionStreamEvent): void {
    const followed = this.#agents.get(sessionId);
    if (followed?.status !== "following") return;
    if (followed.conversation.observe(event)) this.#state = undefined;
  }

  /** The conversation as the tables and this client's own state now show it. */
  get state(): ConversationState {
    if (this.#state !== undefined) return this.#state;
    const { previews, view } = this;
    const interactions = this.#interactions();
    const changed =
      this.#changed === "all"
        ? undefined
        : new Set([
            ...this.#changed,
            // An open turn's previews move without naming it.
            ...Object.values(view.turns).flatMap((turn) =>
              turn.status === "running" ? [turn.turnId] : [],
            ),
          ]);
    const derived = assistantMessages({ interactions, previews, view }, changed);
    if (changed === undefined) this.#messages = new Map();
    for (const [turnId, message] of derived) {
      if (message === undefined) this.#messages.delete(turnId);
      else this.#messages.set(turnId, message);
    }
    this.#changed = new Set();

    const state: Mutable<ConversationState> = {
      agents: this.#agentSessions(),
      interactions,
      messages: this.#orderedMessages(),
      tasks: readerTasks(view),
      turns: readerTurns(view),
    };
    const active = activeTurn(view)?.turnId;
    if (active !== undefined) state.activeTurnId = active;
    Object.defineProperty(state, tablesKey, { value: this });
    this.#state = state;
    return state;
  }

  #touch(turnId: string): void {
    if (this.#changed !== "all") this.#changed.add(turnId);
  }

  #setResponded(responded: Readonly<Record<string, Answer>>): void {
    this.#responded = responded;
    // An answer shows on its interaction's part, wherever that sits.
    this.#changed = "all";
    this.#state = undefined;
  }

  /** Every interaction, an answer this client sent showing it responded. */
  #interactions(): Readonly<Record<string, ConversationInteraction>> {
    const interactions: Record<string, ConversationInteraction> = {};
    for (const interactionId of Object.keys(this.view.interactions)) {
      const shown = interaction(this.view, interactionId);
      if (shown === undefined) continue;
      const answer = this.#responded[interactionId];
      interactions[interactionId] =
        answer !== undefined && shown.status === "open"
          ? { ...shown, answer, status: "responded" }
          : shown;
    }
    return interactions;
  }

  /**
   * Each turn's messages in turn order: what people sent it, in the order it consumed them, then
   * what this client sent it that eve hasn't consumed, then the agent's message. Messages this
   * client sent for no known turn come last.
   */
  #orderedMessages(): readonly EveMessage[] {
    const sent = new Map<string, EveMessage[]>();
    for (const row of Object.values(this.view.deliveries)) {
      if (row.consumedAt === undefined || row.turnId === undefined) continue;
      let message = this.#users.get(row.deliveryId);
      if (message === undefined) {
        message = userMessage(row);
        if (message === undefined) continue;
        this.#users.set(row.deliveryId, message);
      }
      const messages = sent.get(row.turnId);
      if (messages === undefined) sent.set(row.turnId, [message]);
      else messages.push(message);
    }
    const local = new Map<string | undefined, EveMessage[]>();
    for (const submission of this.#submissions) {
      const turnId =
        submission.turnId !== undefined && this.view.turns[submission.turnId] !== undefined
          ? submission.turnId
          : undefined;
      const message: EveMessage = {
        id: `optimistic:${submission.id}:user`,
        metadata: {
          optimistic: true,
          status: submission.error === undefined ? "submitted" : "failed",
        },
        parts: [{ text: submission.message, type: "text" }],
        role: "user",
      };
      const messages = local.get(turnId);
      if (messages === undefined) local.set(turnId, [message]);
      else messages.push(message);
    }
    const messages: EveMessage[] = [];
    for (const turnId of Object.keys(this.view.turns)) {
      messages.push(...(sent.get(turnId) ?? []), ...(local.get(turnId) ?? []));
      const assistant = this.#messages.get(turnId);
      if (assistant !== undefined) messages.push(assistant);
    }
    messages.push(...(local.get(undefined) ?? []));
    return messages;
  }

  /** The sessions this session's calls opened, as this client follows them. */
  #agentSessions(): ConversationState["agents"] {
    const agents: Record<string, ConversationAgentSession> = {};
    for (const child of Object.values(this.view.children)) {
      if (!("callId" in child.owner)) continue;
      const { callId } = child.owner;
      const turnId = callPlace(this.view, callId)?.turnId;
      if (turnId === undefined) continue;
      const followed = this.#agents.get(child.sessionId);
      const agent: Mutable<ConversationAgentSession> = {
        callId,
        name: child.name,
        observation:
          followed === undefined
            ? { status: "not-followed" }
            : { conversation: followed.conversation.state, status: followed.status },
        sessionId: child.sessionId,
        turnId,
      };
      const taskId = this.view.calls[callId]?.taskId;
      if (taskId !== undefined) agent.taskId = taskId;
      agents[child.sessionId] = agent;
    }
    return agents;
  }

  /**
   * Forgets an answer once the stream leaves its interaction without it pending: the interaction
   * settled, or every answer to it was refused or never applied, which leaves it answerable again.
   */
  #forgetSettledAnswer(event: SessionStreamEvent): void {
    const data = event.data as { readonly interactionId?: string; readonly responseId?: string };
    let interactionId: string | undefined;
    if (event.type === "interaction.settled") interactionId = data.interactionId;
    else if (event.type === "response.settled" && data.responseId !== undefined) {
      const settled = this.view.responses[data.responseId];
      if (settled === undefined || settled.outcome === "applied") return;
      const pending = Object.values(this.view.responses).some(
        (response) =>
          response.interactionId === settled.interactionId && response.status !== "settled",
      );
      if (!pending) interactionId = settled.interactionId;
    }
    if (interactionId === undefined || this.#responded[interactionId] === undefined) return;
    const { [interactionId]: _forgotten, ...responded } = this.#responded;
    this.#setResponded(responded);
  }
}

/** The conversation a complete read of a session's stream shows. */
export function conversationOf(events: Iterable<SessionStreamEvent>): ConversationState {
  const conversation = new Conversation();
  for (const event of events) conversation.observe(event);
  return conversation.state;
}

/**
 * The turns whose messages an event may change: the turn its scope or data names, else the turn
 * of the run, part, call, or interaction it names, and for an interaction also the turn of the
 * call it is about, which may be an earlier one.
 */
function touchedTurns(
  view: SessionView,
  previews: SessionPreviews,
  event: SessionStreamEvent,
): readonly string[] {
  const scope = (event as { readonly scope?: { readonly turnId?: string } }).scope;
  const data = (event.data ?? {}) as {
    readonly turnId?: unknown;
    readonly runId?: unknown;
    readonly partId?: unknown;
    readonly callId?: unknown;
    readonly interactionId?: unknown;
    readonly responseId?: unknown;
  };
  const turns = new Set<string>();
  const add = (turnId: string | undefined) => {
    if (turnId !== undefined) turns.add(turnId);
  };
  add(scope?.turnId);
  if (typeof data.turnId === "string") add(data.turnId);
  const runId =
    typeof data.runId === "string"
      ? data.runId
      : typeof data.partId === "string"
        ? (view.parts[data.partId]?.runId ?? previews.parts[data.partId]?.runId)
        : undefined;
  if (runId !== undefined) add(runTurn(view, runId));
  if (typeof data.callId === "string") add(callPlace(view, data.callId)?.turnId);
  const interactionId =
    typeof data.interactionId === "string"
      ? data.interactionId
      : typeof data.responseId === "string"
        ? view.responses[data.responseId]?.interactionId
        : undefined;
  const row = interactionId === undefined ? undefined : view.interactions[interactionId];
  if (row !== undefined) {
    add(interactionPlace(view, row).turnId);
    if ("callId" in row.subject) add(callPlace(view, row.subject.callId)?.turnId);
  }
  return [...turns];
}
