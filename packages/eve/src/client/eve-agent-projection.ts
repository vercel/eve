import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";

/** Owns chronological reducer replay when optimistic events are replaced by server events. */
export class EveAgentProjection<TData> {
  readonly #reducer: EveAgentReducer<TData>;
  #events: EveAgentReducerEvent[];
  #data: TData;

  constructor(reducer: EveAgentReducer<TData>, events: readonly EveAgentReducerEvent[]) {
    this.#reducer = reducer;
    this.#events = [...events];
    this.#data = this.#reduce();
  }

  get data(): TData {
    return this.#data;
  }

  get reducer(): EveAgentReducer<TData> {
    return this.#reducer;
  }

  reset(): void {
    this.#events = [];
    this.#data = this.#reducer.initial();
  }

  append(event: EveAgentReducerEvent): void {
    this.#events.push(event);
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
