import type { SessionStreamEvent } from "#protocol/session-event.js";
import { isFactType, isProgressType } from "#protocol/session-events/catalog.js";
import type { ConversationState, FollowAgents } from "#client/conversation-state.js";
import { AgentStreamFollower } from "#client/agent-stream-follower.js";
import { Conversation, type LocalSubmission } from "#client/conversation.js";
import { assertAnswerable } from "#client/session-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { Answer } from "#shared/input.js";
import {
  SessionEventStream,
  type SessionEventStreamOptions,
} from "#client/session-event-stream.js";
import type { ClientSession } from "#client/session.js";

export class ConversationClient {
  #conversation = new Conversation();
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

  holdUnconfirmedMessages(hold: boolean): void {
    this.#conversation.holdUnconfirmedMessages(hold);
  }

  get streaming(): boolean {
    return this.#stream !== undefined && !this.#stream.ended;
  }

  showSubmissions(submissions: readonly LocalSubmission[]): void {
    this.#conversation.setSubmissions(submissions);
  }

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

  replaceAnswers(
    retract: ReturnType<ConversationClient["projectAnswers"]>,
    input: SendTurnPayload,
  ) {
    retract?.();
    assertAnswerable(input, this.conversation);
    return this.projectAnswers(input.answers);
  }

  observe(
    event: SessionStreamEvent,
    options: {
      reconcile?: (event: SessionStreamEvent) => void;
      onAccepted?: (event: SessionStreamEvent) => void;
      notify?: boolean;
    } = {},
  ): boolean {
    if (!this.#conversation.observe(event)) return false;
    options.onAccepted?.(event);
    options.reconcile?.(event);
    if (options.notify !== false) {
      this.#onChange();
      if (event.meta.endOfLine !== false) this.reconcileFollowing();
    }
    return true;
  }

  reconcileFollowing(): void {
    this.#follower?.reconcile();
  }

  hydrate(event: SessionStreamEvent): boolean {
    assertCurrentSavedEvent(event);
    const covered = this.#conversation.view.position;
    if (!this.#conversation.observe(event)) return false;
    const { next, position, endOfLine } = event.meta;
    if (position.line < covered)
      throw new TypeError(
        "Saved events overlap source lines already covered by the conversation. " +
          "Save the ordered events as eve read them, or read the session again from position 0.",
      );
    if (next !== undefined) {
      if (endOfLine !== true || !Number.isSafeInteger(next) || next < position.line + 1)
        throw new TypeError(
          "Saved `meta.next` must cover a complete source line with a safe integer cursor. " +
            "Save the events as eve read them, or read the session again from position 0.",
        );
      this.#conversation.advancePosition(next);
    }
    return true;
  }

  follow(session: ClientSession, policy: FollowAgents): void {
    this.#follower ??= new AgentStreamFollower({
      session,
      policy,
      conversation: this.#conversation,
      onChange: this.#onChange,
    });
    this.#follower.start();
  }

  stream(session: ClientSession, options: SessionEventStreamOptions): SessionEventStream {
    if (this.#stream !== undefined && !this.#stream.ended) {
      this.#stream.setOptions(options);
      return this.#stream;
    }
    this.#stream = new SessionEventStream(session, {
      ...options,
      startIndex: options.startIndex ?? this.#conversation.view.position,
    });
    return this.#stream;
  }

  closeStream(): void {
    this.#stream?.close();
    this.#stream = undefined;
    this.#conversation.discardUncommitted();
  }

  stop(): void {
    this.#follower?.abortAll();
    this.closeStream();
  }

  reset(): void {
    this.stop();
    this.#follower = undefined;
    this.#conversation = new Conversation();
  }
}

function assertCurrentSavedEvent(event: SessionStreamEvent): void {
  const { meta, type } = event as {
    readonly meta?: { readonly position?: unknown };
    type?: unknown;
  };
  if (meta?.position !== undefined && (isFactType(type) || isProgressType(type))) return;
  throw new TypeError(
    `Saved session event ${JSON.stringify(type)} has no stream position this eve version can ` +
      "read; it was likely saved by eve < 27. Discard saved `initialEvents` and the saved " +
      "session state from before the upgrade, then start a new session.",
  );
}
