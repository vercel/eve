import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ConversationState } from "#client/conversation-state.js";
import { AgentStreamFollower } from "#client/agent-stream-follower.js";
import { Conversation, type LocalSubmission } from "#client/conversation.js";
import { assertAnswerable } from "#client/eve-agent-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
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
  #follower?: AgentStreamFollower;
  #stream?: SessionEventStream;
  readonly #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get conversation(): ConversationState {
    return this.#conversation.state;
  }

  get view(): SessionView {
    return this.#conversation.view;
  }

  confirmSubmission(id: string, deliveryId: string): void {
    this.#conversation.confirmSubmission(id, deliveryId);
  }

  get following(): boolean {
    return this.#follower !== undefined;
  }

  /** Shows the messages this client sent that eve hasn't consumed. */
  showSubmissions(submissions: readonly LocalSubmission[]): void {
    this.#conversation.setSubmissions(submissions);
  }

  /** Projects answers during the POST round trip, then hands ownership to the view. */
  projectAnswers(answers: readonly Answer[] | undefined) {
    if (!answers?.length) return undefined;
    const conversation = this.#conversation;
    const pending = conversation.answer(answers);
    this.#onChange();
    const withdraw = () => {
      if (conversation !== this.#conversation) return;
      pending();
      this.#onChange();
    };
    withdraw.accept = (deliveryId: string) => {
      if (conversation !== this.#conversation) return;
      pending.accept(deliveryId);
      this.#onChange();
    };
    return withdraw;
  }

  /** Swaps shown answers for a prepared payload's, which must still be answerable. */
  replaceAnswers(
    retract: ReturnType<ConversationClient["projectAnswers"]>,
    input: SendTurnPayload,
  ) {
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
    if (!this.#conversation.observe(event)) return false;
    options.onAccepted?.(event);
    options.reconcile?.(event);
    if (options.notify !== false) this.#onChange();
    this.#follower?.acceptParentEvent(event);
    if (event.meta.endOfLine !== false) this.#follower?.reconcile();
    return true;
  }

  /** Admits and folds a saved root event without notifying subscribers. */
  hydrate(event: SessionStreamEvent): boolean {
    return this.#conversation.observe(event);
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
      onEvent: (sessionId, event) => {
        this.#conversation.observeAgent(sessionId, event);
        if (event.meta.endOfLine !== false) this.#onChange();
      },
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
    this.#conversation = new Conversation();
  }
}
