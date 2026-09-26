import type { ChildCall } from "#client/conversation-state.js";
import type { ClientSession } from "#client/session.js";
import type { StreamReconnectPolicy } from "#client/types.js";
import type { MessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";

const childStreamReconnectPolicy = {
  streamIdleReconnectPolicy: { maxAttempts: Infinity },
  streamOpenReconnectPolicy: { maxAttempts: Infinity },
} as const satisfies StreamReconnectPolicy;

export interface SubagentPumpOptions {
  session: (parentSessionId: string) => ClientSession | undefined;
  getCall: (callId: string) => ChildCall | undefined;
  onChildEvent: (callId: string, event: MessageStreamEvent) => void;
  onFollowing: (callId: string) => void;
  onEnded: (callId: string, outcome: "completed" | "failed" | "cancelled") => void;
  onUnavailable: (callId: string, reason: "unsupported-stream" | "stream-error") => void;
  onToolCompleted?: (name: string, toolName: string, output: unknown) => Promise<void>;
}

/** Acquires call-scoped child events; conversation state owns their meaning. */
export class SubagentPump {
  readonly #options: SubagentPumpOptions;
  readonly #calls = new Map<string, SubagentCalledStreamEvent>();
  readonly #active = new Map<string, string>();
  readonly #queued = new Map<string, string[]>();
  readonly #cursors = new Map<string, number>();
  readonly #controllers = new Map<string, AbortController>();
  #disposed = false;

  constructor(options: SubagentPumpOptions) {
    this.#options = options;
  }

  acceptParentEvent(event: MessageStreamEvent): void {
    if (event.type === "subagent.called") this.begin(event);
  }

  begin(event: SubagentCalledStreamEvent): void {
    const { callId, childSessionId } = event.data;
    if (this.#disposed || this.#calls.has(callId)) return;
    this.#calls.set(callId, event);
    const queue = this.#queued.get(childSessionId) ?? [];
    queue.push(callId);
    this.#queued.set(childSessionId, queue);
    this.#advance(childSessionId);
  }

  /** Stop subscriptions whose call was cancelled by the canonical projection. */
  reconcile(): void {
    for (const [sessionId, callId] of this.#active) {
      const call = this.#options.getCall(callId);
      if (call?.parentStatus !== "cancelled") continue;
      this.#controllers.get(callId)?.abort();
      this.#release(sessionId, callId);
    }
  }

  abortAll(): void {
    this.#disposed = true;
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    this.#active.clear();
    this.#queued.clear();
    this.#cursors.clear();
    this.#calls.clear();
  }

  #advance(sessionId: string): void {
    if (this.#disposed || this.#active.has(sessionId)) return;
    const queue = this.#queued.get(sessionId);
    while (queue?.length) {
      const callId = queue.shift()!;
      const called = this.#calls.get(callId);
      const call = this.#options.getCall(callId);
      if (
        called === undefined ||
        call === undefined ||
        call.parentStatus === "cancelled" ||
        call.observation.status === "ended"
      )
        continue;
      this.#active.set(sessionId, callId);
      this.#follow(called);
      return;
    }
    this.#queued.delete(sessionId);
  }

  #release(sessionId: string, callId: string): void {
    if (this.#active.get(sessionId) !== callId) return;
    this.#active.delete(sessionId);
    this.#advance(sessionId);
  }

  #follow(called: SubagentCalledStreamEvent): void {
    const { callId, childSessionId, name } = called.data;
    const session = this.#options.session(called.data.sessionId);
    if (session === undefined || typeof called.data.childStreamPath !== "string") {
      this.#options.onUnavailable(
        callId,
        session === undefined ? "stream-error" : "unsupported-stream",
      );
      this.#release(childSessionId, callId);
      return;
    }
    const controller = new AbortController();
    this.#controllers.set(callId, controller);
    this.#options.onFollowing(callId);
    void (async () => {
      let cursor = this.#cursors.get(childSessionId) ?? 0;
      try {
        for await (const event of session.streamSubagent(called, {
          signal: controller.signal,
          startIndex: cursor,
          streamReconnectPolicy: childStreamReconnectPolicy,
        })) {
          if (controller.signal.aborted) return;
          this.#cursors.set(childSessionId, ++cursor);
          this.#options.onChildEvent(callId, event);
          if (
            event.type === "action.result" &&
            event.data.status === "completed" &&
            event.data.result.kind === "tool-result"
          ) {
            await this.#options.onToolCompleted?.(
              name,
              event.data.result.toolName,
              event.data.result.output,
            );
          }
          if (
            event.type !== "session.waiting" &&
            event.type !== "session.completed" &&
            event.type !== "session.failed"
          )
            continue;
          const call = this.#options.getCall(callId);
          if (
            event.type === "session.waiting" &&
            call?.observation.status === "following" &&
            Object.values(call.observation.conversation.inputs).some(
              (input) => input.status === "open",
            )
          )
            continue;
          const turns =
            call?.observation.status === "following"
              ? Object.values(call.observation.conversation.turns)
              : [];
          const failed = turns.at(-1)?.status === "failed";
          this.#options.onEnded(
            callId,
            event.type === "session.failed" || failed ? "failed" : "completed",
          );
          return;
        }
        if (!controller.signal.aborted) this.#options.onUnavailable(callId, "stream-error");
      } catch {
        if (!controller.signal.aborted) this.#options.onUnavailable(callId, "stream-error");
      } finally {
        controller.abort();
        if (this.#controllers.get(callId) === controller) this.#controllers.delete(callId);
        this.#release(childSessionId, callId);
      }
    })();
  }
}
