/**
 * Server-side session access for code running inside an eve deployment,
 * such as hooks, tools, schedules, and channel routes.
 */

import {
  type SessionEventStreamOptions,
  streamSessionEvents,
} from "#execution/session-event-stream.js";
import type { MessageStreamEvent } from "#protocol/message.js";

/** Options for {@link ServerSession.stream}. */
export type ServerSessionStreamOptions = SessionEventStreamOptions;

/** A handle to one session's durable event stream, read in process. */
export interface ServerSession {
  readonly sessionId: string;
  /**
   * Reads the session's events in stream order. Every event carries its
   * absolute `meta.index`. With `follow: false`, the read ends at the durable
   * tail observed when it opens.
   */
  stream(options?: ServerSessionStreamOptions): AsyncIterable<MessageStreamEvent>;
}

/**
 * Reads session streams in process, without calling the deployment's own
 * HTTP stream route.
 *
 * Available only in code running inside the eve server, where the session
 * store is configured. It reads any session ID without channel auth, so check
 * that the caller may read a session before passing an ID from a request.
 */
export const sessions = {
  attach(sessionId: string): ServerSession {
    return {
      sessionId,
      stream: (options) => streamSessionEvents(sessionId, options),
    };
  },
};
