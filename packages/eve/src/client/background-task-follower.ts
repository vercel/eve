import type { ClientSession } from "#client/session.js";
import { isAbortError } from "#client/eve-agent-store-helpers.js";
import type { MessageStreamEvent } from "#protocol/message.js";

interface BackgroundTaskFollowerCallbacks {
  readonly acceptEvent: (event: MessageStreamEvent) => void;
  readonly onBoundary: (session: ClientSession) => void;
  readonly onError: (error: unknown) => void;
}

export class BackgroundTaskFollower {
  readonly #callbacks: BackgroundTaskFollowerCallbacks;
  #controller: AbortController | undefined;
  #enabled = false;
  #promise: Promise<void> | undefined;

  constructor(callbacks: BackgroundTaskFollowerCallbacks) {
    this.#callbacks = callbacks;
  }

  observe(event: MessageStreamEvent): void {
    if (!isSessionBoundary(event)) return;
    this.#enabled = event.type === "session.waiting" && event.data.backgroundTasks === "pending";
  }

  seed(events: readonly MessageStreamEvent[]): void {
    const boundary = events.findLast(isSessionBoundary);
    if (boundary !== undefined) this.observe(boundary);
  }

  stop(): Promise<void> | undefined {
    this.#controller?.abort();
    return this.#promise;
  }

  reset(): void {
    this.#enabled = false;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#promise = undefined;
  }

  start(session: ClientSession | undefined): void {
    if (!this.#enabled || session === undefined || this.#controller !== undefined) return;

    const controller = new AbortController();
    this.#controller = controller;
    let promise!: Promise<void>;
    promise = this.#follow(session, controller).finally(() => {
      if (this.#controller === controller) this.#controller = undefined;
      if (this.#promise === promise) this.#promise = undefined;
    });
    this.#promise = promise;
  }

  async #follow(session: ClientSession, controller: AbortController): Promise<void> {
    try {
      while (this.#enabled && !controller.signal.aborted) {
        for await (const event of session.stream({ signal: controller.signal })) {
          if (this.#controller !== controller) return;
          this.#callbacks.acceptEvent(event);
          if (isSessionBoundary(event)) {
            this.#callbacks.onBoundary(session);
            break;
          }
        }
      }
    } catch (error) {
      if (!isAbortError(error)) this.#callbacks.onError(error);
    }
  }
}

function isSessionBoundary(
  event: MessageStreamEvent,
): event is Extract<
  MessageStreamEvent,
  { readonly type: "session.completed" | "session.failed" | "session.waiting" }
> {
  return (
    event.type === "session.waiting" ||
    event.type === "session.completed" ||
    event.type === "session.failed"
  );
}
