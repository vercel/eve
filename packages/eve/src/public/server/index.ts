import { builtInHosts } from "#runtime/app.js";
import { streamSessionEvents } from "#execution/session-event-stream.js";
import type { SessionReader } from "#shared/session.js";

/**
 * Reads session streams in process, without calling the deployment's own
 * HTTP stream route.
 *
 * Available only in code running inside the eve server, where the session
 * store is configured. It reads any session ID without channel auth, so check
 * that the caller may read a session before passing an ID from a request.
 */
export const sessions = {
  attach(sessionId: string): SessionReader {
    return {
      id: sessionId,
      stream: (options) => streamSessionEvents(builtInHosts(), sessionId, options),
    };
  },
};
