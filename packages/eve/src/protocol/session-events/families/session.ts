import { z } from "#compiled/zod/index.js";

import { cause, conforming, envelopeOf, errorInfo, id, known } from "../common.js";
import type { Cause, Envelope, ErrorInfo } from "../envelope.js";

/** The eve instance serving a session, for eval reporters. */
export interface RuntimeIdentity {
  readonly agentId: string;
  readonly agentName?: string;
  readonly eveVersion: string;
  readonly build?: {
    readonly deployedAt?: string;
    readonly gitBranch?: string;
    readonly gitSha?: string;
  };
}

/** W3C trace coordinates, for correlating a session with an observability backend. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/** The retired session replaced by this one; its recorded history stays readable. */
export interface SessionPredecessor {
  readonly sessionId: string;
}

/** The payload of `session.started`: the session begins, with its parent, predecessor, runtime, and trace when known. */
export interface SessionStartedData {
  /** The call whose agent opened this session, for a child session. */
  readonly parent?: { readonly sessionId: string; readonly callId: string };
  /**
   * The session this one replaced, when eve started it in place of one whose deployment was
   * retired. Its recorded stream stays readable.
   */
  readonly predecessor?: SessionPredecessor;
  readonly runtime?: RuntimeIdentity;
  readonly trace?: TraceContext;
}

/** How a session ended, as recorded on `session.ended`. */
export type SessionOutcome = "completed" | "failed";

/** The payload of `session.ended`: the session ends, with its outcome and, for a failure, what failed. */
export interface SessionEndedData {
  readonly outcome: SessionOutcome;
  /**
   * What failed, for a failed session, such as the `{turnId}` it failed in. The error is
   * {@link SessionEndedData.error}: the turn settles `cancelled` without one of its own, and
   * `failure(view, turnId)` reads this one for it.
   */
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
}

/** The first fact of a session stream. */
export type SessionStarted = Envelope<"session.started", SessionStartedData>;
/** The terminal fact of a session stream. */
export type SessionEnded = Envelope<"session.ended", SessionEndedData>;
/** Any fact in the `session` family. */
export type SessionFact = SessionStarted | SessionEnded;

export const traceContext = z.object({
  spanId: z.string(),
  traceFlags: z.number().int(),
  traceId: z.string(),
});

const sessionStartedData = conforming<SessionStartedData>()(
  z.object({
    parent: z.object({ callId: id, sessionId: id }).optional(),
    predecessor: z.object({ sessionId: id }).optional(),
    runtime: z
      .object({
        agentId: z.string(),
        agentName: z.string().optional(),
        build: z
          .object({
            deployedAt: z.string().optional(),
            gitBranch: z.string().optional(),
            gitSha: z.string().optional(),
          })
          .optional(),
        eveVersion: z.string(),
      })
      .optional(),
    trace: traceContext.optional(),
  }),
);

const sessionEndedData = conforming<SessionEndedData>()(
  z.object({
    cause: cause.optional(),
    error: errorInfo.optional(),
    outcome: known<SessionOutcome>(),
  }),
);

export const sessionSchemas = {
  "session.ended": envelopeOf("session.ended", sessionEndedData),
  "session.started": envelopeOf("session.started", sessionStartedData),
};
