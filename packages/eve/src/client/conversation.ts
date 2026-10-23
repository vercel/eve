import type {
  AgentObservation,
  ConversationAgentSession,
  ConversationState,
} from "#client/conversation-state.js";
import {
  assistantMessages,
  importedMessages,
  type PlacedMessage,
  userMessage,
} from "#client/messages.js";
import type { EveMessage } from "#client/message-types.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { isFactType } from "#protocol/session-events/catalog.js";
import {
  emptyPreviews,
  emptySessionView,
  foldReceivedEvent,
} from "#protocol/session-projection/fold.js";
import { runTurn } from "#protocol/session-projection/selectors.js";
import type { SessionPreviews, SessionView } from "#protocol/session-projection/tables.js";
import {
  snapshotOf,
  type SessionView as PublicSessionView,
} from "#protocol/session-projection/session-view.js";
import {
  callPlace,
  interaction,
  interactionPlace,
  type Interaction,
} from "#protocol/session-projection/reader.js";
import type { Answer } from "#shared/input.js";
import { answersDeliveryId } from "#shared/answers-delivery-id.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A message this client sent that eve hasn't consumed yet, or that failed to send. */
export interface LocalSubmission {
  readonly id: string;
  readonly message: string;
  /** The open turn a steering message joins, when known. */
  readonly turnId?: string;
  readonly error?: { readonly message: string };
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
  #committedThrough: { readonly line: number; readonly index: number } | undefined;
  #uncommitted: SessionStreamEvent[] = [];
  readonly #pendingAnswers = new Map<string, { readonly answer: Answer; deliveryId?: string }>();
  #submissions: readonly LocalSubmission[] = [];
  #holdUnconfirmedMessages = false;
  readonly #agents = new Map<string, AgentObservation>();
  #messages = new Map<string, readonly PlacedMessage[]>();
  readonly #users = new Map<string, EveMessage>();
  /** The earlier conversation each consumed delivery imported, by delivery. */
  readonly #imported = new Map<string, readonly EveMessage[]>();
  readonly #submissionIds = new Map<string, string>();
  #changed: Set<string> | "all" = "all";
  #state: ConversationState | undefined;
  #viewCopy: PublicSessionView | undefined;
  #viewPosition = -1;

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
    this.#uncommitted.push(event);
    if (event.meta?.endOfLine === false) return true;
    const committed = this.#uncommitted;
    this.#uncommitted = [];
    this.#committedThrough = this.#through;
    for (const fact of committed) {
      foldReceivedEvent(this.view, fact, this.previews);
      if (fact.type === "delivery.consumed" && (fact.data.history?.length ?? 0) > 0)
        this.#imported.set(
          fact.data.deliveryId,
          importedMessages(fact.data.deliveryId, fact.data.history!),
        );
      if (isFactType(fact.type)) this.#viewCopy = undefined;
      for (const turnId of touchedTurns(this.view, this.previews, fact)) this.#touch(turnId);
    }
    this.#forgetAdmittedAnswers();
    this.#state = undefined;
    return true;
  }

  /** Advances over source lines without recognized facts, after the reader commits the whole line. */
  advancePosition(position: number): void {
    if (this.#uncommitted.length !== 0 || position <= this.view.position) return;
    (this.view as Mutable<SessionView>).position = position;
    this.#state = undefined;
    this.#viewCopy = undefined;
  }

  /** Forgets a partly received line so a reader replaying from the folded cursor admits it again. */
  discardUncommitted(): void {
    this.#uncommitted = [];
    this.#through = this.#committedThrough;
  }

  /** Projects an answer only until its accepted delivery appears in the view. */
  answer(answers: readonly Answer[]) {
    const entries = answers.map((answer) => ({
      answer,
      deliveryId: undefined as string | undefined,
    }));
    for (const entry of entries) {
      if (this.view.interactions[entry.answer.interactionId]?.status === "open") {
        this.#pendingAnswers.set(entry.answer.interactionId, entry);
      }
    }
    this.#answersChanged();
    const retract = () => {
      for (const entry of entries) {
        const id = entry.answer.interactionId;
        if (this.#pendingAnswers.get(id) === entry) this.#pendingAnswers.delete(id);
      }
      this.#answersChanged();
    };
    retract.accept = (deliveryId: string) => {
      for (const entry of entries) entry.deliveryId = deliveryId;
      this.#forgetAdmittedAnswers();
      this.#answersChanged();
    };
    return retract;
  }

  /** Keeps the local echo's identity when its durable delivery replaces it. */
  confirmSubmission(id: string, deliveryId: string): void {
    this.#submissionIds.set(deliveryId, id);
    this.#state = undefined;
  }

  /** A pending receipt has not yet identified which durable user row replaces its echo. */
  holdUnconfirmedMessages(hold: boolean): void {
    if (this.#holdUnconfirmedMessages === hold) return;
    this.#holdUnconfirmedMessages = hold;
    this.#state = undefined;
  }

  /** Shows, replaces, or removes the messages this client sent that eve hasn't consumed. */
  setSubmissions(submissions: readonly LocalSubmission[]): void {
    this.#submissions = submissions;
    this.#state = undefined;
  }

  get submissions(): readonly LocalSubmission[] {
    return this.#submissions;
  }

  /** Updates a child observation without mixing its facts into this session's projection. */
  observeAgent(sessionId: string, observation: AgentObservation): void {
    this.#agents.set(sessionId, observation);
    this.#state = undefined;
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
    for (const [turnId, messages] of derived) {
      if (messages.length === 0) this.#messages.delete(turnId);
      else this.#messages.set(turnId, messages);
    }
    this.#changed = new Set();

    const state: Mutable<ConversationState> = {
      agents: this.#agentSessions(),
      view: this.#frozenView,
      messages: this.#orderedMessages(),
    };
    this.#state = state;
    return state;
  }

  get #frozenView(): PublicSessionView {
    if (this.#viewCopy !== undefined && this.#viewPosition === this.view.position)
      return this.#viewCopy;
    this.#viewPosition = this.view.position;
    return (this.#viewCopy = snapshotOf(this.view, this.previews));
  }

  #touch(turnId: string): void {
    if (this.#changed !== "all") this.#changed.add(turnId);
  }

  #answersChanged(): void {
    this.#changed = "all";
    this.#state = undefined;
  }

  /** Every interaction, an answer this client sent showing it responded. */
  #interactions(): Readonly<Record<string, Interaction>> {
    const interactions: Record<string, Interaction> = {};
    for (const interactionId of Object.keys(this.view.interactions)) {
      const shown = interaction(this.view, interactionId);
      if (shown === undefined) continue;
      const answer = this.#pendingAnswers.get(interactionId)?.answer;
      interactions[interactionId] =
        answer !== undefined && shown.status === "open" ? { ...shown, answer } : shown;
    }
    return interactions;
  }

  /**
   * Each turn's messages in turn order, as the stream placed them: what people sent it where it
   * consumed them, between the agent's messages, then what this client sent it that eve hasn't
   * consumed. Messages this client sent for no known turn come last.
   */
  #orderedMessages(): readonly EveMessage[] {
    const sent = new Map<string, PlacedMessage[]>();
    const imported = new Map<string, PlacedMessage[]>();
    for (const row of Object.values(this.view.deliveries)) {
      if (row.consumedAt === undefined || row.turnId === undefined) continue;
      const at = row.consumedAt;
      const history = (this.#imported.get(row.deliveryId) ?? []).map((message) => ({
        at,
        message,
      }));
      if (history.length > 0)
        imported.set(row.turnId, [...(imported.get(row.turnId) ?? []), ...history]);
      const submissionId = this.#submissionIds.get(row.deliveryId);
      let message = this.#users.get(row.deliveryId);
      if (this.#holdUnconfirmedMessages && message === undefined && submissionId === undefined)
        continue;
      if (message === undefined) {
        message = userMessage(row);
        if (message === undefined) continue;
        this.#users.set(row.deliveryId, message);
      }
      const shown =
        submissionId === undefined
          ? message
          : { ...message, id: `optimistic:${submissionId}:user` };
      const placed = { at: row.consumedAt, message: shown };
      const messages = sent.get(row.turnId);
      if (messages === undefined) sent.set(row.turnId, [placed]);
      else messages.push(placed);
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
      // On one line, imported history sorts before what people sent, as the model reads them, and
      // a person's message sorts before the agent's that starts there.
      const placed = [
        ...(imported.get(turnId) ?? []).map((entry) => ({ ...entry, rank: -1 })),
        ...(sent.get(turnId) ?? []).map((entry) => ({ ...entry, rank: 0 })),
        ...(this.#messages.get(turnId) ?? []).map((entry) => ({ ...entry, rank: 1 })),
      ].sort((a, b) => a.at - b.at || a.rank - b.rank);
      messages.push(...placed.map((entry) => entry.message), ...(local.get(turnId) ?? []));
    }
    messages.push(...(local.get(undefined) ?? []));
    return messages;
  }

  /** The sessions this session's calls opened, as this client follows them. */
  #agentSessions(): ConversationState["agents"] {
    const agents: Record<string, ConversationAgentSession> = {};
    for (const child of Object.values(this.view.children)) {
      const callId = "callId" in child.owner ? child.owner.callId : undefined;
      const agent: Mutable<ConversationAgentSession> = {
        owner: child.owner,
        name: child.name,
        observation: this.#agents.get(child.sessionId) ?? { status: "not-followed" },
        sessionId: child.sessionId,
      };
      if (callId !== undefined) {
        agent.callId = callId;
        agent.turnId = callPlace(this.view, callId)?.turnId;
        agent.taskId = this.view.calls[callId]?.taskId;
      } else if ("taskId" in child.owner) agent.taskId = child.owner.taskId;
      agents[child.sessionId] = agent;
    }
    return agents;
  }

  #forgetAdmittedAnswers(): void {
    for (const [id, pending] of this.#pendingAnswers) {
      if (
        pending.deliveryId !== undefined &&
        (this.view.deliveries[pending.deliveryId] !== undefined ||
          this.view.deliveries[answersDeliveryId(pending.deliveryId)] !== undefined)
      ) {
        this.#pendingAnswers.delete(id);
        this.#answersChanged();
      }
    }
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
