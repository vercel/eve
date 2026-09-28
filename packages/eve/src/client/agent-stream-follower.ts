import {
  isAgentSessionCaughtUp,
  isAgentToolSession,
  type ConversationState,
} from "#client/conversation-state.js";
import type { ClientSession } from "#client/session.js";
import type { StreamReconnectPolicy } from "#client/types.js";
import type { AgentStartedStreamEvent, MessageStreamEvent } from "#protocol/message.js";

/**
 * A followed session can stay silent while a person answers its question, and the dev server can
 * restart underneath it, so only an abort or a non-retryable failure ends a subscription.
 */
const agentStreamReconnectPolicy = {
  streamIdleReconnectPolicy: { maxAttempts: Infinity },
  streamOpenReconnectPolicy: { maxAttempts: Infinity },
} as const satisfies StreamReconnectPolicy;

export interface AgentStreamFollowerOptions {
  /** The session whose stream announced the agents; reads use its host and credentials. */
  readonly session: ClientSession;
  readonly getState: () => ConversationState;
  readonly onFollowing: (sessionId: string) => void;
  readonly onEvent: (sessionId: string, event: MessageStreamEvent) => void;
  readonly onIdle: (sessionId: string) => void;
  readonly onUnavailable: (sessionId: string) => void;
  /** Retained by the transport owner across detach and reattach. */
  readonly cursors: Map<string, number>;
}

/**
 * Follows each agent tool's session while its task has content the conversation has not shown.
 * The conversation decides when a session is caught up; this class only owns transport.
 */
export class AgentStreamFollower {
  readonly #options: AgentStreamFollowerOptions;
  readonly #started = new Map<string, AgentStartedStreamEvent>();
  readonly #controllers = new Map<string, AbortController>();
  /** Sessions whose stream failed stay unavailable until the owner follows again. */
  readonly #failed = new Set<string>();
  #disposed = false;

  constructor(options: AgentStreamFollowerOptions) {
    this.#options = options;
  }

  acceptParentEvent(event: MessageStreamEvent): void {
    if (event.type === "agent.started") this.#started.set(event.data.sessionId, event);
  }

  /** Starts, resumes, or pauses subscriptions to match the conversation. */
  reconcile(): void {
    if (this.#disposed) return;
    const state = this.#options.getState();
    for (const agent of Object.values(state.agents)) {
      if (!isAgentToolSession(state, agent)) continue;
      const controller = this.#controllers.get(agent.sessionId);
      const caughtUp = isAgentSessionCaughtUp(state, agent);
      if (controller !== undefined && caughtUp) {
        this.#controllers.delete(agent.sessionId);
        controller.abort();
        this.#options.onIdle(agent.sessionId);
      } else if (controller === undefined && !caughtUp && !this.#failed.has(agent.sessionId)) {
        this.#follow(agent.sessionId);
      }
    }
  }

  abortAll(): void {
    this.#disposed = true;
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
  }

  #follow(sessionId: string): void {
    const started = this.#started.get(sessionId);
    if (started === undefined) return;
    const controller = new AbortController();
    this.#controllers.set(sessionId, controller);
    this.#options.onFollowing(sessionId);
    const { cursors } = this.#options;
    void (async () => {
      let cursor = cursors.get(sessionId) ?? 0;
      try {
        for await (const event of this.#options.session.agent(started).stream({
          signal: controller.signal,
          startIndex: cursor,
          streamReconnectPolicy: agentStreamReconnectPolicy,
        })) {
          if (controller.signal.aborted) return;
          cursors.set(sessionId, ++cursor);
          this.#options.onEvent(sessionId, event);
          this.reconcile();
        }
      } catch {
        // Reported below unless the subscription was deliberately aborted.
      }
      if (controller.signal.aborted || this.#controllers.get(sessionId) !== controller) return;
      this.#controllers.delete(sessionId);
      this.#failed.add(sessionId);
      this.#options.onUnavailable(sessionId);
    })();
  }
}
