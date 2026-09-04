import type { ClientSession } from "#client/session.js";
import { isAbortError } from "#client/eve-agent-store-helpers.js";
import type { MessageStreamEvent } from "#protocol/message.js";

interface BackgroundTaskFollowerCallbacks {
  readonly acceptEvent: (event: MessageStreamEvent) => void;
  readonly getSession: () => ClientSession | undefined;
  readonly onError: (error: unknown) => void;
  readonly onWaiting: (session: ClientSession) => void;
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
    if (isBackgroundTaskReceiptEvent(event)) this.#enabled = true;
  }

  seed(events: readonly MessageStreamEvent[]): void {
    this.#enabled = events.some(isBackgroundTaskReceiptEvent);
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

  start(): void {
    const session = this.#callbacks.getSession();
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
          if (event.type === "session.waiting") {
            this.#callbacks.onWaiting(session);
          } else if (event.type === "session.completed" || event.type === "session.failed") {
            this.#enabled = false;
          }
        }
      }
    } catch (error) {
      if (!isAbortError(error)) this.#callbacks.onError(error);
    }
  }
}

export function isBackgroundTaskReceiptEvent(event: MessageStreamEvent): boolean {
  if (event.type === "subagent.completed") {
    return event.data.backgroundTask?.status === "working";
  }
  if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return false;

  const output = event.data.result.output;
  return (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    output.status === "working" &&
    "taskId" in output &&
    typeof output.taskId === "string"
  );
}
