import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";

/** Framework-owned origin captured when the authorized caller subscribes. */
export interface Experimental_ConnectionEventOrigin {
  readonly sessionId: string;
  readonly connectionName: string;
  readonly subscriptionId: string;
}

export interface Experimental_ConnectionEventContext {
  readonly origin: Experimental_ConnectionEventOrigin;
  readonly deliveryId: string;
  /** The subscription creator's authenticated session identity. */
  readonly auth: SessionAuthContext | null;
  /** Attaches to an existing session; never creates a replacement session. */
  readonly attachSession: (sessionId: string) => Session;
}

export interface Experimental_ConnectionEvent {
  readonly eventId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly cursor: string | null;
}

/** Opts a static Connect-backed MCP connection into managed webhook events. */
export interface Experimental_ConnectionEvents {
  /** Called durably after verification and subscription binding checks. */
  readonly onEvent: (
    input: Experimental_ConnectionEventContext & {
      readonly event: Experimental_ConnectionEvent;
    },
  ) => void | PromiseLike<void>;
  /** The upstream server could not deliver a contiguous event stream. */
  readonly onGap?: (
    input: Experimental_ConnectionEventContext & {
      readonly cursor: string | null;
      readonly truncated?: true;
    },
  ) => void | PromiseLike<void>;
  /** The upstream subscription ended; no model turn starts automatically. */
  readonly onTerminated?: (
    input: Experimental_ConnectionEventContext & {
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
    },
  ) => void | PromiseLike<void>;
}
