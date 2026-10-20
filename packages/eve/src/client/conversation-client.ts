import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ConversationState } from "#client/conversation-state.js";
import { AgentStreamFollower } from "#client/agent-stream-follower.js";
import { Conversation, type LocalSubmission } from "#client/conversation.js";
import { assertAnswerable } from "#client/eve-agent-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import type { Answer } from "#shared/input.js";
import {
  SessionEventStream,
  type SessionEventStreamOptions,
} from "#client/session-event-stream.js";
import type { ClientSession } from "#client/session.js";

/** Owns one client session's conversation and its root and agent-session transports. */
export class ConversationClient {
  #conversation = new Conversation();
  readonly #cursors = new Map<string, number>();
  #seenEvents = createEventDeduper();
  #follower?: AgentStreamFollower;
  #stream?: SessionEventStream;
  readonly #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get conversation(): ConversationState {
    return this.#conversation.state;
  }

  get following(): boolean {
    return this.#follower !== undefined;
  }

  /** Shows the messages this client sent that eve hasn't consumed. */
  showSubmissions(submissions: readonly LocalSubmission[]): void {
    this.#conversation.setSubmissions(submissions);
  }

  /** Shows submitted answers as responded; the returned callback withdraws them if the server never accepts. */
  projectAnswers(answers: readonly Answer[] | undefined): (() => void) | undefined {
    if (!answers?.length) return undefined;
    const conversation = this.#conversation;
    const withdraw = conversation.answer(answers);
    this.#onChange();
    return () => {
      if (conversation !== this.#conversation) return;
      withdraw();
      this.#onChange();
    };
  }

  /** Swaps shown answers for a prepared payload's, which must still be answerable. */
  replaceAnswers(
    retract: (() => void) | undefined,
    input: SendTurnPayload,
  ): (() => void) | undefined {
    retract?.();
    assertAnswerable(input, this.conversation);
    return this.projectAnswers(input.answers);
  }

  /** Admits and folds a root event before the agent sessions it announces are followed. */
  observe(
    event: SessionStreamEvent,
    options: {
      /** Reconciles the messages this client sent with the event. */
      reconcile?: (event: SessionStreamEvent) => void;
      /** Records the accepted event before it folds or children hear of it. */
      onAccepted?: (event: SessionStreamEvent) => void;
      /** The store publishes after updating its event log and status. */
      notify?: boolean;
    } = {},
  ): boolean {
    if (!this.#seenEvents.admit(event)) return false;
    options.onAccepted?.(event);
    this.#conversation.observe(event);
    options.reconcile?.(event);
    if (options.notify !== false) this.#onChange();
    this.#follower?.acceptParentEvent(event);
    this.#follower?.reconcile();
    return true;
  }

  /** Admits and folds a saved root event without notifying subscribers. */
  hydrate(event: SessionStreamEvent): boolean {
    if (!this.#seenEvents.admit(event)) return false;
    this.#conversation.observe(event);
    return true;
  }

  /** Starts following the agent sessions the root stream has announced so far. */
  follow(session: ClientSession, events: readonly SessionStreamEvent[] = []): void {
    this.#follower?.abortAll();
    const changed = (update: (conversation: Conversation) => void) => {
      update(this.#conversation);
      this.#onChange();
    };
    const follower = new AgentStreamFollower({
      session,
      cursors: this.#cursors,
      getState: () => this.conversation,
      onFollowing: (sessionId) => changed((c) => c.follow(sessionId, "following")),
      onEvent: (sessionId, event) => changed((c) => c.observeAgent(sessionId, event)),
      onIdle: (sessionId) => changed((c) => c.follow(sessionId, "idle")),
      onUnavailable: (sessionId) => changed((c) => c.follow(sessionId, "unavailable")),
    });
    this.#follower = follower;
    for (const event of events) follower.acceptParentEvent(event);
    follower.reconcile();
  }

  /** Follows the root session continuously; operation readers subscribe to this one stream. */
  stream(session: ClientSession, options: SessionEventStreamOptions): SessionEventStream {
    if (this.#stream !== undefined && !this.#stream.ended) {
      this.#stream.setOptions(options);
      return this.#stream;
    }
    this.#stream = new SessionEventStream(session, options);
    return this.#stream;
  }

  /** Closes the root stream; the next `stream()` call reopens it from the session cursor. */
  closeStream(): void {
    this.#stream?.close();
    this.#stream = undefined;
  }

  stop(): void {
    this.#follower?.abortAll();
    this.#follower = undefined;
    this.closeStream();
  }

  reset(): void {
    this.stop();
    this.#cursors.clear();
    this.#seenEvents = createEventDeduper();
    this.#conversation = new Conversation();
  }
}
