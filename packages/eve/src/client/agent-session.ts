import type { SessionStreamEvent } from "#protocol/session-event.js";
import { followStreamIterable, type FollowedEvent } from "#client/open-stream.js";
import type { ClientSessionContext } from "#client/session.js";
import type { StreamOptions } from "#client/types.js";
import type { AgentStartedStreamEvent } from "#protocol/message.js";

/**
 * A session an agent run opened, reached through the parent session whose
 * stream announced it with `agent.started`. Get one with
 * `session.agent(started)`. Every read uses the parent's host and
 * credentials: a local child's own route, or the parent-origin proxy for a
 * remote child, which the parent deployment authenticates to the remote agent
 * after checking that it recorded the child.
 */
export class ClientAgentSession {
  /** The agent's name, as `agent.started` reports it. */
  readonly name: string;
  /** The child session's id. */
  readonly sessionId: string;
  /** The task whose run opened the session; absent when an `execute` call opened it. */
  readonly taskId: string | undefined;
  readonly #context: ClientSessionContext;
  readonly #streamPath: string;

  /** @internal */
  constructor(context: ClientSessionContext, started: AgentStartedStreamEvent) {
    this.#context = context;
    this.#streamPath = started.data.streamPath;
    this.name = started.data.name;
    this.sessionId = started.data.sessionId;
    this.taskId = started.data.taskId;
  }

  /**
   * Follows the child's durable event stream. Reading it never advances the
   * parent session's cursor. The child cursor starts at `0`; pass `startIndex`
   * to resume. Stop at a child turn boundary with `isCurrentTurnBoundaryEvent`.
   */
  async *stream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    for await (const { event } of this.follow(options)) yield event;
  }

  /** @internal The child's events with the cursor to resume from after each. */
  follow(options?: StreamOptions): AsyncIterable<FollowedEvent> {
    const startIndex = options?.startIndex ?? 0;
    return followStreamIterable({
      follow: options?.follow,
      host: this.#context.host,
      path: this.#streamPath,
      redirect: this.#context.redirect,
      resolveHeaders: () => this.#context.resolveHeaders(),
      signal: options?.signal,
      startIndex,
      streamReconnectPolicy: options?.streamReconnectPolicy,
    });
  }
}
