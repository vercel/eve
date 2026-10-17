import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { Client } from "#client/client.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { ConversationState } from "#client/conversation-state.js";
import type { ClientSession } from "#client/session.js";
import type {
  ClientAuth,
  ClientSessionState,
  HeadersValue,
  SendTurnPayload,
} from "#client/types.js";

/** Local transport activity; request and turn outcomes live in `view`, errors in `error`. */
export type EveAgentStoreStatus = "idle" | "busy" | "resuming";

/**
 * Prepares one outbound turn immediately before the client sends it, for
 * example to attach fresh one-turn page state through `clientContext`.
 */
export type PrepareSend = (input: SendTurnPayload) => SendTurnPayload | Promise<SendTurnPayload>;

export interface EveAgentStoreSnapshot extends ConversationState {
  /** Authoritative lifecycle tables as of this committed snapshot. */
  readonly view: SessionView;
  /** The latest session creation, stream, resume, or turn failure. */
  readonly error: Error | undefined;
  readonly events: readonly SessionStreamEvent[];
  readonly session: ClientSessionState | undefined;
  readonly status: EveAgentStoreStatus;
}

/**
 * Hooks invoked during session creation and turn processing. The observation callbacks
 * do not alter execution; `prepareSend` may replace the outbound turn payload.
 */
export interface EveAgentStoreCallbacks {
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: SessionStreamEvent) => void;
  readonly onFinish?: (snapshot: EveAgentStoreSnapshot) => void;
  readonly onSessionChange?: (session: ClientSessionState | undefined) => void;
  readonly prepareSend?: PrepareSend;
}

/**
 * Configuration for constructing an eve frontend session store. Pass connection
 * options or a configured `Client` for store-owned sessions, or an existing
 * `ClientSession`. Saved events must be an ordered prefix of the same session stream.
 */
export interface EveAgentStoreInit {
  readonly prewarm?: boolean;
  /** Configured client for store-owned sessions; replaces `host`, `auth`, and `headers`. */
  readonly client?: Client;
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  readonly host?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly SessionStreamEvent[];
  readonly initialSession?: ClientSessionState;
  readonly optimistic?: boolean;
  /**
   * Follow each agent tool's session into `agents` while the store streams its session or a
   * framework binding has it mounted.
   */
  readonly followSubagents?: boolean;
  /**
   * Keep the session stream open while the session is idle, so the store sees events that arrive
   * between turns from schedules, channels, or other clients. When false, the store closes the
   * stream once no turn, task, or sign-in is pending, and reopens it from the session cursor on
   * the next send, answer, or resume.
   *
   * @default true
   */
  readonly followIdle?: boolean;
  readonly session?: ClientSession;
}
