type AbortListener = ((this: AbortSignal, ev: Event) => unknown) | { handleEvent(ev: Event): void };

export class InWorkflowAbortSignal implements AbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
  readonly #listeners = new Set<{ readonly listener: AbortListener; readonly once: boolean }>();

  addEventListener(
    type: string,
    listener: AbortListener | null,
    options?: boolean | { readonly once?: boolean },
  ): void {
    if (type !== "abort" || listener === null) return;
    const once = typeof options === "object" && options !== null && options.once === true;
    this.#listeners.add({ listener, once });
  }

  removeEventListener(type: string, listener: AbortListener | null): void {
    if (type !== "abort" || listener === null) return;
    for (const entry of this.#listeners) {
      if (entry.listener === listener) this.#listeners.delete(entry);
    }
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  abort(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason ?? new Error("The operation was aborted.");
    const event = { type: "abort" } as Event;
    this.onabort?.call(this, event);
    for (const entry of Array.from(this.#listeners)) {
      if (entry.once) this.#listeners.delete(entry);
      if (typeof entry.listener === "function") entry.listener.call(this, event);
      else entry.listener.handleEvent(event);
    }
  }
}

export class InWorkflowAbortController {
  readonly signal = new InWorkflowAbortSignal();

  abort(reason?: unknown): void {
    this.signal.abort(reason);
  }
}
