import type { ConversationEvent } from "#client/conversation-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";

interface ProjectionReducer<TData, TEvent> {
  initial(): TData;
  reduce(data: TData, event: TEvent): TData;
}

/**
 * The part of a projection that root-stream bookkeeping writes. Its entries can include the
 * canonical conversation's agent-session events, so predicates see the wider event type.
 */
export interface EveAgentEventLog {
  append(event: EveAgentReducerEvent): void;
  remove(predicate: (event: ConversationEvent) => boolean): void;
  replace(
    predicate: (event: ConversationEvent) => boolean,
    replacement: EveAgentReducerEvent,
  ): void;
}

/** Owns chronological reducer replay when optimistic events are replaced by server events. */
export class EveAgentProjection<TData, TEvent = EveAgentReducerEvent> {
  readonly #reducer: ProjectionReducer<TData, TEvent>;
  #events: TEvent[];
  #data: TData;

  constructor(reducer: ProjectionReducer<TData, TEvent>, events: readonly TEvent[]) {
    this.#reducer = reducer;
    this.#events = [...events];
    this.#data = this.#reduce();
  }

  get data(): TData {
    return this.#data;
  }

  get reducer(): ProjectionReducer<TData, TEvent> {
    return this.#reducer;
  }

  reset(): void {
    this.#events = [];
    this.#data = this.#reducer.initial();
  }

  append(event: TEvent): void {
    this.#events.push(event);
    this.#data = this.#reducer.reduce(this.#data, event);
  }

  remove(predicate: (event: TEvent) => boolean): void {
    this.#events = this.#events.filter((event) => !predicate(event));
    this.#data = this.#reduce();
  }

  replace(predicate: (event: TEvent) => boolean, replacement: TEvent): void {
    const index = this.#events.findIndex(predicate);
    if (index === -1) this.#events.push(replacement);
    else this.#events[index] = replacement;
    this.#data = this.#reduce();
  }

  #reduce(): TData {
    let data = this.#reducer.initial();
    for (const event of this.#events) data = this.#reducer.reduce(data, event);
    return data;
  }
}
