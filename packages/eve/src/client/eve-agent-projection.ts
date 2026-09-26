import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";

/** Owns reducer replay when optimistic events are replaced by server events. */
export class EveAgentProjection<TData> {
  readonly #reducer: EveAgentReducer<TData>;
  #events: readonly EveAgentReducerEvent[];
  #childEvents: EveAgentReducerEvent[] = [];
  #data: TData;

  constructor(reducer: EveAgentReducer<TData>, events: readonly EveAgentReducerEvent[]) {
    this.#reducer = reducer;
    this.#events = events;
    this.#data = this.#reduce();
  }

  get data(): TData {
    return this.#data;
  }

  reset(): void {
    this.#events = [];
    this.#childEvents = [];
    this.#data = this.#reducer.initial();
  }

  append(event: EveAgentReducerEvent): void {
    if (
      event.type === "client.child.observed" ||
      event.type === "client.child.following" ||
      event.type === "client.child.settled"
    ) {
      this.#childEvents.push(event);
    } else {
      this.#events = [...this.#events, event];
    }
    this.#data = this.#reducer.reduce(this.#data, event);
  }

  remove(predicate: (event: EveAgentReducerEvent) => boolean): void {
    this.#events = this.#events.filter((event) => !predicate(event));
    this.#data = this.#reduce();
  }

  replace(
    predicate: (event: EveAgentReducerEvent) => boolean,
    replacement: EveAgentReducerEvent,
  ): void {
    const index = this.#events.findIndex(predicate);
    this.#events =
      index === -1
        ? [...this.#events, replacement]
        : this.#events.map((event, i) => (i === index ? replacement : event));
    this.#data = this.#reduce();
  }

  #reduce(): TData {
    let data = this.#reducer.initial();
    for (const event of this.#events) data = this.#reducer.reduce(data, event);
    for (const event of this.#childEvents) data = this.#reducer.reduce(data, event);
    return data;
  }
}
