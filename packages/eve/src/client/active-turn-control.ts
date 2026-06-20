type ActiveTurnPhase =
  | { readonly kind: "preparing" }
  | { readonly kind: "dispatching" }
  | { readonly cancel: () => Promise<boolean>; readonly kind: "running" };

/** Coordinates local aborts with a server cancellation handle that arrives after dispatch. */
export class ActiveTurnControl {
  readonly #abortController = new AbortController();
  #cancellationRequested = false;
  #phase: ActiveTurnPhase = { kind: "preparing" };
  #stopRequested = false;

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  beginDispatch(): boolean {
    if (this.#phase.kind !== "preparing") {
      throw new Error("Turn dispatch has already started.");
    }
    if (this.#stopRequested) {
      this.#abortController.abort();
      return false;
    }
    this.#phase = { kind: "dispatching" };
    return true;
  }

  attachCancellation(cancel: () => Promise<boolean>): void {
    if (this.#phase.kind !== "dispatching") {
      throw new Error("Cannot attach cancellation before dispatch starts.");
    }
    this.#phase = { cancel, kind: "running" };
    if (this.#stopRequested) {
      this.#requestCancellation(cancel);
    }
  }

  stop(): void {
    this.#stopRequested = true;
    if (this.#phase.kind === "preparing") {
      this.#abortController.abort();
    } else if (this.#phase.kind === "running") {
      this.#requestCancellation(this.#phase.cancel);
    }
  }

  #requestCancellation(cancel: () => Promise<boolean>): void {
    if (this.#cancellationRequested) return;
    this.#cancellationRequested = true;
    void cancel()
      .then((cancelled) => {
        if (!cancelled) this.#abortController.abort();
      })
      .catch(() => this.#abortController.abort());
  }
}
