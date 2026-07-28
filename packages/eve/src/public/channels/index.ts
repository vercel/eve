export {
  defineChannel,
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
  WS,
  type Channel,
  type ChannelCors,
  type ChannelCorsOptions,
  type ChannelDefinition,
  type ChannelSessionOps,
  type ChannelEvents,
  type InferChannelMetadata,
  type Session,
  type SessionHandle,
  type RouteDefinition,
  type RouteHandlerArgs,
  type SendFn,
  type SendOptions,
  type SendPayload,
  type GetSessionFn,
  type HttpRouteDefinition,
  type WebSocketMessage,
  type WebSocketPeer,
  type WebSocketRouteDefinition,
  type WebSocketRouteHandler,
  type WebSocketRouteHooks,
  type WebSocketUpgradeRequest,
  type WebSocketUpgradeResult,
} from "#public/definitions/channel.js";
export {
  createWebSocketUpgradeServer,
  type WebSocketUpgradeServerBridge,
} from "#channel/websocket-upgrade-server.js";

import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import type { Channel, InferChannelMetadata } from "#public/definitions/channel.js";

/**
 * Base channel metadata shape used by framework channel kinds.
 */
export type InstrumentationChannelMetadata = Readonly<Record<string, unknown>>;

/**
 * Kind discriminator exposed to instrumentation and dynamic resolvers.
 */
export type InstrumentationChannelKind =
  | "http"
  | "schedule"
  | "subagent"
  | "unknown"
  | `channel:${string}`;

/**
 * Instrumentation projection for one channel kind.
 */
export interface InstrumentationChannelForKind<K extends InstrumentationChannelKind> {
  readonly kind: K;
  readonly metadata: InstrumentationChannelMetadata;
}

/**
 * Channel shape received by instrumentation callbacks and dynamic resolvers.
 * Use {@link isChannel} with a channel definition to narrow authored metadata.
 */
export type InstrumentationChannel = InstrumentationChannelForKind<InstrumentationChannelKind>;

/**
 * Instrumentation channel narrowed to the metadata projected by `TChannel`.
 */
export type InstrumentationChannelForChannel<TChannel extends Channel<any, any, any>> = Omit<
  InstrumentationChannelForKind<`channel:${string}`>,
  "metadata"
> & {
  readonly metadata: InferChannelMetadata<TChannel>;
};

/**
 * Narrows a channel by comparing it to an app-owned channel value imported
 * from `agent/channels/*`.
 *
 * Works with both instrumentation resolver inputs (`input.channel`) and
 * dynamic resolver inputs (`ctx.channel`). The comparison uses the
 * compiler's path-derived `channel:<slug>` identity. Metadata is inferred
 * directly from the target channel definition.
 */
export function isChannel<TChannel extends Channel<any, any, any>>(
  channel: InstrumentationChannel | { readonly kind?: string },
  target: TChannel,
): channel is InstrumentationChannelForChannel<TChannel> {
  return channel.kind === getChannelInstrumentationKind(target);
}
