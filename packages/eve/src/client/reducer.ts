import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#runtime/input/types.js";

/**
 * Client-side reducer event emitted before eve confirms a submitted user
 * message with a `message.received` stream event.
 */
export interface ClientMessageSubmittedEvent {
  readonly data: {
    readonly createdAt: number;
    readonly message: string;
    readonly submissionId: string;
  };
  readonly type: "client.message.submitted";
}

/**
 * Client-side reducer event emitted when a submitted user message fails before
 * eve confirms it with a `message.received` stream event.
 */
export interface ClientMessageFailedEvent {
  readonly data: {
    readonly createdAt: number;
    readonly error: {
      readonly message: string;
    };
    readonly message: string;
    readonly submissionId: string;
  };
  readonly type: "client.message.failed";
}

/**
 * Client-side reducer event emitted when the client submits HITL responses for
 * pending input requests.
 */
export interface ClientInputRespondedEvent {
  readonly data: {
    readonly createdAt: number;
    readonly responses: readonly InputResponse[];
  };
  readonly type: "client.input.responded";
}

/**
 * Event consumed by eve agent reducers.
 *
 * Server events are authoritative eve stream events. They include text,
 * reasoning, tool/action requests and results, HITL input requests, connection
 * authorization events, subagent events, and session lifecycle events. Client
 * events are projection-only events created by client state machines for local
 * UI state such as optimistic user messages and submitted HITL responses.
 */
export type EveAgentReducerEvent =
  | ClientInputRespondedEvent
  | ClientMessageFailedEvent
  | ClientMessageSubmittedEvent
  | HandleMessageStreamEvent;

/**
 * Projects eve stream events into accumulated consumer data.
 */
export interface EveAgentReducer<TData> {
  /**
   * Creates the initial projection state.
   */
  initial(): TData;

  /**
   * Applies one server or client projection event to the current projection.
   */
  reduce(data: TData, event: EveAgentReducerEvent): TData;
}
