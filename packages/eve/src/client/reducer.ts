import type { MessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

/**
 * Client-side reducer event emitted before eve confirms a submitted user
 * message with a `message.received` stream event.
 */
export interface ClientMessageSubmittedEvent {
  readonly data: {
    readonly createdAt: number;
    readonly message: string;
    readonly submissionId: string;
    /** Active turn receiving a steered follow-up, when known. */
    readonly turnId?: string;
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
    /** Active turn receiving a steered follow-up, when known. */
    readonly turnId?: string;
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
 * Client-side reducer event emitted as the client starts, pauses, or loses its
 * subscription to a session a run opened with `ctx.agent`.
 */
export interface ClientAgentSessionEvent {
  readonly data: { readonly sessionId: string };
  readonly type: "client.agent.following" | "client.agent.idle" | "client.agent.unavailable";
}

/** Client-side reducer event carrying one event from a followed agent session's stream. */
export interface ClientAgentObservedEvent {
  readonly data: { readonly event: MessageStreamEvent; readonly sessionId: string };
  readonly type: "client.agent.observed";
}

/**
 * Event consumed by eve agent reducers.
 *
 * Server events are authoritative eve stream events. They include text,
 * reasoning, tool/action requests and results, HITL input requests, connection
 * authorization events, task and agent-session events, and session lifecycle events. Client
 * events are projection-only events created by client state machines for local
 * UI state such as optimistic user messages and submitted HITL responses.
 */
export type EveAgentReducerEvent =
  | ClientAgentSessionEvent
  | ClientAgentObservedEvent
  | ClientInputRespondedEvent
  | ClientMessageFailedEvent
  | ClientMessageSubmittedEvent
  | MessageStreamEvent;

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
