import type { MessageResponse } from "#client/message-response.js";
import type { EveAgentReducer } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type {
  CancelSessionResult,
  ClientAuth,
  ClientSessionState,
  HeadersValue,
  SendTurnPayload,
} from "#client/types.js";

/**
 * Lifecycle state of an eve frontend session store: `ready` (idle),
 * `resuming` (checking an attached session for continuation), `submitted`
 * (turn sent, awaiting the first event), `streaming` (events arriving), and
 * `error` (session creation, streaming, resume, or a turn failed).
 */
export type EveAgentStoreStatus = "error" | "ready" | "resuming" | "streaming" | "submitted";

/**
 * Prepares one outbound turn immediately before the client sends it, for
 * example to attach fresh one-turn page state through `clientContext`.
 */
export type PrepareSend = (input: SendTurnPayload) => SendTurnPayload | Promise<SendTurnPayload>;

/** Immutable projected state of an eve frontend session store. */
export interface EveAgentStoreSnapshot<TData> {
  readonly data: TData;
  /** The latest session creation, stream, resume, or turn failure. */
  readonly error: Error | undefined;
  readonly events: readonly MessageStreamEvent[];
  readonly session: ClientSessionState | undefined;
  readonly status: EveAgentStoreStatus;
}

/**
 * Hooks invoked during session creation and turn processing. The observation callbacks
 * do not alter execution; `prepareSend` may replace the outbound turn payload.
 */
export interface EveAgentStoreCallbacks<TData> {
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: MessageStreamEvent) => void;
  readonly onFinish?: (snapshot: EveAgentStoreSnapshot<TData>) => void;
  readonly onSessionChange?: (session: ClientSessionState | undefined) => void;
  readonly prepareSend?: PrepareSend;
}

/**
 * Configuration for constructing an eve frontend session store. Pass either
 * connection options for a store-owned session or an existing `ClientSession`.
 * Saved events must be an ordered prefix of the same session stream.
 */
export interface EveAgentStoreInit<TData> {
  readonly prewarm?: boolean;
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  readonly host?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly MessageStreamEvent[];
  readonly initialSession?: ClientSessionState;
  readonly optimistic?: boolean;
  /** Follow child streams into the default projection. Disabled for custom reducers. */
  readonly followSubagents?: boolean;
  readonly reducer: EveAgentReducer<TData>;
  readonly session?: ClientSession;
}

export interface PendingMessageSubmission {
  readonly createdAt: number;
  readonly eventStartIndex: number;
  readonly id: string;
  readonly message: string;
  readonly requiresDeliveryId: boolean;
  readonly deliveryId?: string;
}

export interface ActiveTurn {
  readonly abortController: AbortController;
  acceptedFollowUps: number;
  readonly cancel: () => Promise<CancelSessionResult>;
  readonly completion: Promise<void>;
  readonly followUpDispatches: Set<Promise<void>>;
  receivedFollowUps: number;
  readonly receivedFollowUpEvents: Map<MessageStreamEvent, number>;
  readonly followUpSubmissionIds: Set<string>;
  readonly resolveCompletion: () => void;
  readonly response: Promise<MessageResponse | undefined>;
  readonly resolveResponse: (response: MessageResponse | undefined) => void;
}
