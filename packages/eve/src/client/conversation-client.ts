import type { ConversationState } from "#client/conversation-state.js";
import {
  ChildStreamFollower,
  type ChildStreamFollowerOptions,
} from "#client/child-stream-follower.js";
import { conversationReducer } from "#client/conversation-reducer.js";
import { EveAgentProjection } from "#client/eve-agent-projection.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  SessionEventStream,
  type SessionEventStreamOptions,
} from "#client/session-event-stream.js";
import type { ClientSession } from "#client/session.js";

/** Owns the canonical conversation and its root and child transports for one client session. */
export class ConversationClient<TData = ConversationState> {
  readonly projection: EveAgentProjection<TData>;
  readonly #conversation: EveAgentProjection<ConversationState>;
  readonly #cursors = new Map<string, number>();
  #seenEvents = createEventDeduper();
  #follower?: ChildStreamFollower;
  #stream?: SessionEventStream;
  readonly #onChange: (data: TData, previous: TData) => void;
  readonly #onConversationChange?: (state: ConversationState, previous: ConversationState) => void;

  constructor(
    projection: EveAgentProjection<TData>,
    onChange: (data: TData, previous: TData) => void,
    onConversationChange?: (state: ConversationState, previous: ConversationState) => void,
  ) {
    this.projection = projection;
    this.#conversation =
      projection.reducer === conversationReducer
        ? (projection as EveAgentProjection<ConversationState>)
        : new EveAgentProjection(conversationReducer, []);
    this.#onChange = onChange;
    this.#onConversationChange = onConversationChange;
  }

  get data(): TData {
    return this.projection.data;
  }

  get conversation(): ConversationState {
    return this.#conversation.data;
  }

  get projections(): readonly EveAgentProjection<unknown>[] {
    return this.#conversation === this.projection
      ? [this.projection]
      : [this.#conversation, this.projection];
  }

  get following(): boolean {
    return this.#follower !== undefined;
  }

  append(event: EveAgentReducerEvent): void {
    const previous = this.data;
    const previousConversation = this.conversation;
    if (this.#conversation !== this.projection) this.#conversation.append(event);
    this.projection.append(event);
    if (previous !== this.data) this.#onChange(this.data, previous);
    else if (previousConversation !== this.conversation)
      this.#onConversationChange?.(this.conversation, previousConversation);
  }

  /** Admit and project a root event before its child calls begin following. */
  observe(
    event: MessageStreamEvent,
    options: {
      /** The store reconciles optimistic messages instead of directly appending the event. */
      project?: (event: MessageStreamEvent) => void;
      /** Record the accepted event before projection or child notifications. */
      onAccepted?: (event: MessageStreamEvent) => void;
      /** The store publishes after updating its event log and status. */
      notify?: boolean;
    } = {},
  ): boolean {
    if (!this.#seenEvents.admit(event)) return false;
    options.onAccepted?.(event);
    const previous = this.data;
    const previousConversation = this.conversation;
    if (options.project) options.project(event);
    else {
      if (this.#conversation !== this.projection) this.#conversation.append(event);
      this.projection.append(event);
    }
    if (options.notify !== false) {
      if (previous !== this.data) this.#onChange(this.data, previous);
      else if (previousConversation !== this.conversation)
        this.#onConversationChange?.(this.conversation, previousConversation);
    }
    this.#follower?.acceptParentEvent(event);
    if (event.type === "turn.cancelled") this.#follower?.reconcile();
    return true;
  }

  /** Admit and project a hydrated root event without notifying subscribers. */
  hydrate(event: MessageStreamEvent): boolean {
    if (!this.#seenEvents.admit(event)) return false;
    if (this.#conversation !== this.projection) this.#conversation.append(event);
    this.projection.append(event);
    return true;
  }

  /** Start following child calls already observed in the parent stream. */
  follow(
    options: Pick<ChildStreamFollowerOptions, "session">,
    events: readonly MessageStreamEvent[] = [],
  ): void {
    this.#follower?.abortAll();
    this.#follower = new ChildStreamFollower({
      ...options,
      cursors: this.#cursors,
      getCall: (callId) => this.conversation.children[callId],
      onFollowing: (callId) =>
        this.#appendChild({ type: "client.child.following", data: { callId } }),
      onUnavailable: (data) => this.#appendChild({ type: "client.child.unavailable", data }),
      onChildEvent: (callId, event) =>
        this.#appendChild({ type: "client.child.observed", data: { callId, event } }),
    });
    for (const event of events) this.#follower.acceptParentEvent(event);
  }

  #appendChild(event: EveAgentReducerEvent): void {
    if (this.#conversation === this.projection) {
      this.append(event);
    } else {
      const previous = this.conversation;
      this.#conversation.append(event);
      if (previous !== this.conversation) this.#onConversationChange?.(this.conversation, previous);
    }
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

  stop(): void {
    this.#follower?.abortAll();
    this.#follower = undefined;
    this.#stream?.close();
    this.#stream = undefined;
  }

  reset(): void {
    this.stop();
    this.#cursors.clear();
    this.#seenEvents = createEventDeduper();
    if (this.#conversation !== this.projection) this.#conversation.reset();
    this.projection.reset();
  }
}
