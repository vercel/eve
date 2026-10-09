import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ConversationState } from "#client/conversation-state.js";
import { AgentStreamFollower } from "#client/agent-stream-follower.js";
import {
  canonicalConversationReducer,
  conversationReducer,
  type ClientAgentEvent,
  type ConversationEvent,
} from "#client/conversation-reducer.js";
import { EveAgentProjection, type EveAgentEventLog } from "#client/eve-agent-projection.js";
import { assertAnswerable } from "#client/eve-agent-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import type { InputResponse } from "#shared/input.js";
import {
  SessionEventStream,
  type SessionEventStreamOptions,
} from "#client/session-event-stream.js";
import type { ClientSession } from "#client/session.js";

/** Owns the canonical conversation and its root and agent-session transports for one client session. */
export class ConversationClient<TData = ConversationState> {
  readonly projection: EveAgentProjection<TData>;
  readonly #conversation: EveAgentProjection<ConversationState, ConversationEvent>;
  readonly #cursors = new Map<string, number>();
  #seenEvents = createEventDeduper();
  #follower?: AgentStreamFollower;
  #stream?: SessionEventStream;
  readonly #onChange: (data: TData, previous: TData) => void;
  readonly #onConversationChange?: (state: ConversationState, previous: ConversationState) => void;

  constructor(
    projection: EveAgentProjection<TData>,
    onChange: (data: TData, previous: TData) => void,
    onConversationChange?: (state: ConversationState, previous: ConversationState) => void,
  ) {
    this.projection = projection;
    // The default reducer is the canonical one, so `data` and `conversation` share one projection.
    this.#conversation =
      projection.reducer === conversationReducer
        ? (projection as EveAgentProjection<ConversationState, ConversationEvent>)
        : new EveAgentProjection(canonicalConversationReducer, []);
    this.#onChange = onChange;
    this.#onConversationChange = onConversationChange;
  }

  get data(): TData {
    return this.projection.data;
  }

  get conversation(): ConversationState {
    return this.#conversation.data;
  }

  get projections(): readonly EveAgentEventLog[] {
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
    this.#appendRoot(event);
    if (previous !== this.data) this.#onChange(this.data, previous);
    else if (previousConversation !== this.conversation)
      this.#onConversationChange?.(this.conversation, previousConversation);
  }

  /** Projects submitted answers; the returned callback withdraws them if the server never accepts. */
  projectResponses(responses: readonly InputResponse[] | undefined): (() => void) | undefined {
    if (!responses?.length) return undefined;
    const event: EveAgentReducerEvent = {
      data: { createdAt: Date.now(), responses },
      type: "client.input.responded",
    };
    this.append(event);
    return () => this.#retract(event);
  }

  /** Swaps projected answers for a prepared payload's, which must still be answerable. */
  replaceResponses(
    retract: (() => void) | undefined,
    input: SendTurnPayload,
  ): (() => void) | undefined {
    retract?.();
    assertAnswerable(input, this.conversation);
    return this.projectResponses(input.inputResponses);
  }

  #retract(event: EveAgentReducerEvent): void {
    const previous = this.data;
    const previousConversation = this.conversation;
    for (const projection of this.projections) projection.remove((entry) => entry === event);
    if (previous !== this.data) this.#onChange(this.data, previous);
    else if (previousConversation !== this.conversation)
      this.#onConversationChange?.(this.conversation, previousConversation);
  }

  /** Admit and project a root event before the agent sessions it announces are followed. */
  observe(
    event: SessionStreamEvent,
    options: {
      /** The store reconciles optimistic messages instead of directly appending the event. */
      project?: (event: SessionStreamEvent) => void;
      /** Record the accepted event before projection or child notifications. */
      onAccepted?: (event: SessionStreamEvent) => void;
      /** The store publishes after updating its event log and status. */
      notify?: boolean;
    } = {},
  ): boolean {
    if (!this.#seenEvents.admit(event)) return false;
    options.onAccepted?.(event);
    const previous = this.data;
    const previousConversation = this.conversation;
    if (options.project) options.project(event);
    else this.#appendRoot(event);
    if (options.notify !== false) {
      if (previous !== this.data) this.#onChange(this.data, previous);
      else if (previousConversation !== this.conversation)
        this.#onConversationChange?.(this.conversation, previousConversation);
    }
    this.#follower?.acceptParentEvent(event);
    this.#follower?.reconcile();
    return true;
  }

  /** Admit and project a hydrated root event without notifying subscribers. */
  hydrate(event: SessionStreamEvent): boolean {
    if (!this.#seenEvents.admit(event)) return false;
    this.#appendRoot(event);
    return true;
  }

  /** Start following the agent sessions the root stream has announced so far. */
  follow(session: ClientSession, events: readonly SessionStreamEvent[] = []): void {
    this.#follower?.abortAll();
    const follower = new AgentStreamFollower({
      session,
      cursors: this.#cursors,
      getState: () => this.conversation,
      onFollowing: (sessionId) =>
        this.#appendChild({ type: "client.agent.following", data: { sessionId } }),
      onEvent: (sessionId, event) =>
        this.#appendChild({ type: "client.agent.observed", data: { sessionId, event } }),
      onIdle: (sessionId) => this.#appendChild({ type: "client.agent.idle", data: { sessionId } }),
      onUnavailable: (sessionId) =>
        this.#appendChild({ type: "client.agent.unavailable", data: { sessionId } }),
    });
    this.#follower = follower;
    for (const event of events) follower.acceptParentEvent(event);
    follower.reconcile();
  }

  #appendRoot(event: EveAgentReducerEvent): void {
    for (const projection of this.projections) projection.append(event);
  }

  #appendChild(event: ClientAgentEvent): void {
    const previous = this.data;
    const previousConversation = this.conversation;
    this.#conversation.append(event);
    if (previous !== this.data) this.#onChange(this.data, previous);
    else if (previousConversation !== this.conversation)
      this.#onConversationChange?.(this.conversation, previousConversation);
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
    for (const projection of this.projections) projection.reset();
  }
}
