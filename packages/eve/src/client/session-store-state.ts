import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { Client } from "#client/client.js";
import type { SessionView } from "#protocol/session-projection/session-view.js";
import type { ConversationState, FollowAgents } from "#client/conversation-state.js";
import type { ClientSession } from "#client/session.js";
import type {
  ClientAuth,
  ClientSessionState,
  HeadersValue,
  SendTurnPayload,
} from "#client/types.js";

/**
 * Outstanding work the store has observed or still owes: `"resuming"` during catch-up, `"busy"`
 * while a command, answer, or followed receipt is pending or the observed view is not idle, and
 * otherwise `"idle"`. A turn waiting only on a person is open while the store is idle; read
 * `activeTurn(view)` for turn openness. Errors live in `error`.
 */
export type SessionStoreStatus = "idle" | "busy" | "resuming";

/**
 * Prepares one outbound turn immediately before the client sends it, for
 * example to attach fresh one-turn page state through `clientContext`.
 */
export type PrepareSend = (input: SendTurnPayload) => SendTurnPayload | Promise<SendTurnPayload>;

export interface SessionStoreSnapshot extends ConversationState {
  /** Immutable lifecycle observations as of this complete commit. */
  readonly view: SessionView;
  /** The latest session creation, stream, resume, or turn failure. */
  readonly error: Error | undefined;
  readonly events: readonly SessionStreamEvent[];
  readonly session: ClientSessionState | undefined;
  readonly status: SessionStoreStatus;
}

/**
 * Hooks invoked during session creation and turn processing. The observation callbacks
 * do not alter execution; `prepareSend` may replace the outbound turn payload.
 */
export interface SessionStoreCallbacks {
  /** Reports live failures and transport errors; recorded historical failures only update `error`. */
  readonly onError?: (error: Error) => void;
  /** Observes newly read events, including catch-up events. */
  readonly onEvent?: (event: SessionStreamEvent) => void;
  /** Fires once per live settled turn after its complete commit, never for catch-up (even for a local receipt). */
  readonly onFinish?: (snapshot: SessionStoreSnapshot) => void;
  readonly onSessionChange?: (session: ClientSessionState | undefined) => void;
  readonly prepareSend?: PrepareSend;
}

/**
 * Configuration for constructing an eve frontend session store. Pass connection
 * options or a configured `Client` for store-owned sessions, or an existing
 * `ClientSession`. Saved events must be an ordered prefix of the same session stream.
 */
export interface SessionStoreInit {
  readonly prewarm?: boolean;
  /** Configured client for store-owned sessions; replaces `baseUrl`, `auth`, and `headers`. */
  readonly client?: Client;
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  readonly baseUrl?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly SessionStreamEvent[];
  readonly initialSession?: ClientSessionState;
  readonly optimistic?: boolean;
  /**
   * Recursively observe recorded child sessions, including workflow-created children, while
   * mounted or programmatically streaming. A predicate selects relationships at each known depth;
   * `true` is equivalent to `() => true`. Returning false also excludes that child's descendants.
   * Observation is bounded to depth 8, 128 admitted children, and 8 simultaneous descendant reads.
   * Call results and root callbacks never wait for descendant catch-up. Off by default.
   */
  readonly followAgents?: FollowAgents;
  /**
   * Keep following while this predicate accepts the last committed view. Local POSTs, unsettled
   * receipts, and resume catch-up keep the stream open regardless. Evaluated only at complete
   * line boundaries; a closed stream reopens on any command, resume, or follow, from the
   * store's committed position. If it closes during machine work, the snapshot remains busy
   * until reopened. Defaults to always following, including between turns.
   */
  readonly followWhile?: (view: SessionView) => boolean;
  readonly session?: ClientSession;
}
