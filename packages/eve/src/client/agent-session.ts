import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { SessionReader } from "#shared/session.js";
import { followStreamIterable, type FollowedEvent } from "#client/open-stream.js";
import { ClientError } from "#client/client-error.js";
import type { ClientSessionContext } from "#client/session.js";
import type { SessionStreamOptions } from "#client/types.js";
import { createEveDescendantStreamRoutePath } from "#protocol/routes.js";
import {
  EVE_OBSERVATION_KEY_HEADER,
  type DescendantHop,
} from "#protocol/descendant-observation.js";

/** A read-only child reached through recorded relationships on its parent's authorized reader. */
export class ClientAgentSession implements SessionReader {
  readonly name: string;
  readonly id: string;
  readonly taskId: string | undefined;
  readonly #context: ClientSessionContext;
  readonly #rootId: string;
  readonly #children: readonly DescendantHop[];

  /** @internal */
  constructor(
    context: ClientSessionContext,
    rootId: string,
    opened: Extract<SessionStreamEvent, { type: "child.opened" }>,
    children: readonly DescendantHop[] = [],
  ) {
    const position = opened.meta?.position?.line;
    if (!Number.isSafeInteger(position) || position < 0)
      throw new TypeError("Pass a received child.opened event with its committed source position.");
    this.#context = context;
    this.#rootId = rootId;
    this.#children = [...children, { sessionId: opened.data.sessionId, position }];
    this.name = opened.data.name;
    this.id = opened.data.sessionId;
    this.taskId =
      opened.scope?.taskId ??
      ("taskId" in opened.data.owner ? opened.data.owner.taskId : undefined);
  }

  /** Resolves a further recorded child through this reader, including remote proxy hops. */
  agent(opened: Extract<SessionStreamEvent, { type: "child.opened" }>): ClientAgentSession {
    return new ClientAgentSession(this.#context, this.#rootId, opened, this.#children);
  }

  /** Reads independently of its parent; `follow: false` stops at the captured durable tail. */
  async *stream(options?: SessionStreamOptions): AsyncGenerator<SessionStreamEvent> {
    for await (const { event } of this.follow(options)) yield event;
  }

  /** @internal The child's events and durable line cursor, with server-established provenance. */
  follow(
    options?: SessionStreamOptions,
    onIdentity?: (key: string) => void,
    onCaughtUp?: () => void,
    onPosition?: (position: number) => void,
  ): AsyncIterable<FollowedEvent> {
    return followStreamIterable({
      follow: options?.follow,
      onCaughtUp,
      onPosition,
      baseUrl: this.#context.baseUrl,
      path: createEveDescendantStreamRoutePath(this.#rootId),
      searchParams: { children: JSON.stringify(this.#children) },
      redirect: "error",
      resolveHeaders: () => this.#context.resolveHeaders(),
      signal: options?.signal,
      startIndex: options?.startIndex ?? 0,
      streamReconnectPolicy: options?.streamReconnectPolicy,
      onOpen: (headers) => {
        if (onIdentity === undefined) return;
        const key = headers.get(EVE_OBSERVATION_KEY_HEADER);
        if (key === null || key.length > 8192)
          throw new ClientError(422, "Descendant reader provenance is unavailable.");
        onIdentity(key);
      },
    });
  }
}
