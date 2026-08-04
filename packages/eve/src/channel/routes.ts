import type { UserContent } from "ai";

import type { CrossChannelReceiveFn } from "#channel/cross-channel-receive.js";
import type { ChannelAddressFn } from "#channel/channel-address.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { Session } from "#channel/session.js";
import type { JsonObject } from "#shared/json.js";
import type { ChannelMethod } from "#public/definitions/channel.js";

type WebSocketHeaders = Headers | readonly (readonly [string, string])[] | Record<string, string>;

/**
 * Second argument passed to every route handler. `channelAddress` binds a
 * current-owner handle, `attachSession` binds an immutable-ID handle, and
 * `receive` hands inbound work to a different channel.
 */
export interface RouteHandlerArgs<TState = undefined> {
  /** Binds a channel-local continuation token to its current-owner operation surface. */
  channelAddress: ChannelAddressFn<TState>;
  /** Attaches a fixed operation handle to one exact durable session ID without performing I/O. */
  attachSession: AttachSessionFn;
  /**
   * Starts a session on a different channel to hand off inbound work (e.g. an
   * HTTP webhook routing the conversation onto Slack). The target's authored
   * `receive` hook owns continuation-token format and initial state; the caller
   * supplies the payload, channel-specific args, and auth.
   */
  receive: CrossChannelReceiveFn;
  params: Readonly<Record<string, string>>;
  waitUntil: (task: Promise<unknown>) => void;
  requestIp: string | null;
}

export interface SendPayload {
  readonly message?: string | UserContent;
  readonly inputResponses?: readonly InputResponse[];
  /**
   * Context strings contributed by the channel. eve appends each entry
   * as a `role: "user"` message to `session.history` before the delivery
   * message and persists it across the session.
   */
  readonly context?: readonly string[];
  /**
   * Run-scoped JSON schema the turn's result must match. eve enforces the
   * schema in conversation and task mode; mode only decides failure behavior.
   */
  readonly outputSchema?: JsonObject;
}

/** Attaches an I/O-free handle to one exact durable session ID. */
export type AttachSessionFn = (sessionId: string) => Session;

export type RouteHandler<TState = undefined> = (
  req: Request,
  args: RouteHandlerArgs<TState>,
) => Promise<Response>;

/**
 * A connected WebSocket peer passed to every {@link WebSocketRouteHooks}
 * callback. Send frames with `send`; manage pub/sub topics with `subscribe`,
 * `unsubscribe`, and `publish` (`topics` is the current subscription set).
 * `close` closes gracefully; `terminate` aborts the socket immediately.
 */
export interface WebSocketPeer {
  readonly id: string;
  readonly context: Record<string, unknown>;
  readonly namespace: string;
  readonly request: Request;
  readonly remoteAddress?: string;
  readonly topics: Set<string>;
  close(code?: number, reason?: string): void;
  publish(topic: string, data: unknown, options?: { compress?: boolean }): void;
  send(data: unknown, options?: { compress?: boolean }): number | void | undefined;
  subscribe(topic: string): void;
  terminate(): void;
  unsubscribe(topic: string): void;
}

/**
 * An inbound WebSocket frame passed to the `message` hook. `rawData` is the
 * original payload as received; `data` is the decoded value. Use `json`,
 * `text`, `arrayBuffer`, `blob`, or `uint8Array` to decode it explicitly.
 */
export interface WebSocketMessage {
  readonly data: unknown;
  readonly id: string;
  readonly rawData: unknown;
  arrayBuffer(): ArrayBuffer | SharedArrayBuffer;
  blob(): Blob;
  json<T = unknown>(): T;
  text(): string;
  uint8Array(): Uint8Array;
}

/**
 * The `Request` passed to the `upgrade` hook, extended with an optional
 * `context` bag carrying host-supplied data for the upgrade.
 */
export interface WebSocketUpgradeRequest extends Request {
  readonly context?: Record<string, unknown>;
}

/**
 * Return value of the `upgrade` hook. Return an object to attach `context`,
 * `headers`, or a `namespace`, or to mark the upgrade `handled`; return a
 * `Response` to reject the handshake; return `void` to proceed with defaults.
 */
export type WebSocketUpgradeResult =
  | {
      readonly context?: Record<string, unknown>;
      readonly handled?: boolean;
      readonly headers?: WebSocketHeaders;
      readonly namespace?: string;
    }
  | Response
  | void;

/**
 * Lifecycle callbacks for a WebSocket connection. `open`, `message`, `close`,
 * and `error` react to peer activity; `upgrade` runs first and may rewrite or
 * short-circuit the handshake by returning a {@link WebSocketUpgradeResult}.
 */
export interface WebSocketRouteHooks {
  close?(peer: WebSocketPeer, details: { code?: number; reason?: string }): void | Promise<void>;
  error?(peer: WebSocketPeer, error: Error): void | Promise<void>;
  message?(peer: WebSocketPeer, message: WebSocketMessage): void | Promise<void>;
  open?(peer: WebSocketPeer): void | Promise<void>;
  upgrade?(
    request: WebSocketUpgradeRequest,
  ): Promise<WebSocketUpgradeResult> | WebSocketUpgradeResult;
}

/**
 * Handler for a {@link WS} route. Runs once per upgrade request and returns the
 * {@link WebSocketRouteHooks} for that connection.
 */
export type WebSocketRouteHandler<TState = undefined> = (
  req: Request,
  args: RouteHandlerArgs<TState>,
) => Promise<WebSocketRouteHooks> | WebSocketRouteHooks;

/**
 * An HTTP route descriptor (method, path, handler). `transport` is optional and
 * treated as `"http"`: any route whose `transport` is not `"websocket"` is
 * dispatched over HTTP.
 */
export interface HttpRouteDefinition<TState = undefined> {
  readonly transport?: "http";
  readonly method: ChannelMethod;
  readonly path: string;
  readonly handler: RouteHandler<TState>;
}

/**
 * A WebSocket route descriptor produced by {@link WS}. Its `handler` returns the
 * {@link WebSocketRouteHooks} for each connection.
 */
export interface WebSocketRouteDefinition<TState = undefined> {
  readonly transport: "websocket";
  readonly method: "WEBSOCKET";
  readonly path: string;
  readonly handler: WebSocketRouteHandler<TState>;
}

/**
 * A single channel route: either an {@link HttpRouteDefinition} or a
 * {@link WebSocketRouteDefinition}. Produced by the {@link GET}, {@link POST},
 * {@link PUT}, {@link PATCH}, {@link DELETE}, and {@link WS} helpers and listed
 * in a channel's `routes` array.
 */
export type RouteDefinition<TState = undefined> =
  | HttpRouteDefinition<TState>
  | WebSocketRouteDefinition<TState>;

/**
 * Declares an HTTP `GET` route at `path`, dispatching to `handler`. The handler
 * receives the `Request` and {@link RouteHandlerArgs}.
 */
export function GET<TState = undefined>(
  path: string,
  handler: RouteHandler<TState>,
): HttpRouteDefinition<TState> {
  return { transport: "http", method: "GET", path, handler };
}

/**
 * Declares an HTTP `POST` route at `path`. See {@link GET} for the handler
 * contract.
 */
export function POST<TState = undefined>(
  path: string,
  handler: RouteHandler<TState>,
): HttpRouteDefinition<TState> {
  return { transport: "http", method: "POST", path, handler };
}

/**
 * Declares an HTTP `PUT` route at `path`. See {@link GET} for the handler
 * contract.
 */
export function PUT<TState = undefined>(
  path: string,
  handler: RouteHandler<TState>,
): HttpRouteDefinition<TState> {
  return { transport: "http", method: "PUT", path, handler };
}

/**
 * Declares an HTTP `PATCH` route at `path`. See {@link GET} for the handler
 * contract.
 */
export function PATCH<TState = undefined>(
  path: string,
  handler: RouteHandler<TState>,
): HttpRouteDefinition<TState> {
  return { transport: "http", method: "PATCH", path, handler };
}

/**
 * Declares an HTTP `DELETE` route at `path`. See {@link GET} for the handler
 * contract.
 */
export function DELETE<TState = undefined>(
  path: string,
  handler: RouteHandler<TState>,
): HttpRouteDefinition<TState> {
  return { transport: "http", method: "DELETE", path, handler };
}

/**
 * Declares a WebSocket channel route.
 *
 * The handler runs once per upgrade request and returns lifecycle hooks for
 * that connection. The hooks are eve-owned structural types so channel authors
 * can use CrossWS-compatible helpers without eve exposing CrossWS directly.
 */
export function WS<TState = undefined>(
  path: string,
  handler: WebSocketRouteHandler<TState>,
): WebSocketRouteDefinition<TState> {
  return { transport: "websocket", method: "WEBSOCKET", path, handler };
}

export function isHttpRouteDefinition<TState>(
  route: RouteDefinition<TState>,
): route is HttpRouteDefinition<TState> {
  return route.transport !== "websocket";
}

export function isWebSocketRouteDefinition<TState>(
  route: RouteDefinition<TState>,
): route is WebSocketRouteDefinition<TState> {
  return route.transport === "websocket";
}
