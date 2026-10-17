export {
  defineChannel,
  disableRoute,
  GET,
  HEAD,
  OPTIONS,
  POST,
  PUT,
  PATCH,
  DELETE,
  WS,
  type AttachSessionFn,
  SessionStrandedError,
  SessionNotActiveError,
  type Delivery,
  type DeliveryResult,
  type Channel,
  type ChannelAudience,
  type AudienceCaller,
  type AudienceContext,
  type ConversationEnvironment,
  type ChannelFrom,
  type ChannelReceiveContext,
  type ChannelResolveSession,
  type ChannelRespondOptions,
  type ChannelSendOptions,
  type ChannelSource,
  type ChannelCors,
  type ChannelCorsOptions,
  type ChannelDefinition,
  type ChannelDelivery,
  type DisabledRouteSentinel,
  type ChannelContinuationOps,
  type ChannelEvents,
  type InferChannelMetadata,
  type Session,
  type SessionOperations,
  type SessionHandle,
  type SessionRespondOptions,
  type SessionSendOptions,
  type TurnPolicy,
  type RouteDefinition,
  type RouteHandlerArgs,
  type AgentDescription,
  type AgentSkillDescription,
  type AgentSkillFileDescription,
  type AgentToolDescription,
  type InvokeToolFn,
  type InvokeToolOptions,
  type InvokeToolResult,
  type HttpRouteDefinition,
  type WebSocketMessage,
  type WebSocketPeer,
  type WebSocketRouteDefinition,
  type WebSocketRouteHandler,
  type WebSocketRouteHooks,
  type WebSocketUpgradeRequest,
  type WebSocketUpgradeResult,
  type ChannelCommitHandler,
  type ChannelEventContext,
  type CommittedLine,
  isDisabledRouteSentinel,
} from "#public/definitions/channel.js";
export { attachmentError } from "#public/channels/attachment-error.js";
export type {
  FetchFileContext,
  FetchFileFunction,
  FetchFileResult,
} from "#shared/channel-definition.js";
export type {
  MessageContent,
  MessageFilePart,
  MessagePart,
  MessageTextPart,
} from "#shared/message-content.js";
export {
  createWebSocketUpgradeServer,
  type WebSocketUpgradeServerBridge,
} from "#channel/websocket-upgrade-server.js";

import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import type { Channel, InferChannelMetadata } from "#public/definitions/channel.js";
import type { ChannelInfo } from "#shared/channel-info.js";
export type { ChannelInfo, ChannelKind } from "#shared/channel-info.js";

/** Narrows authored metadata only when the input actually carries metadata. */
export function isChannel<TChannel extends Channel<any, any, any>>(
  channel: ChannelInfo,
  target: TChannel,
): channel is ChannelInfo<InferChannelMetadata<TChannel>>;
export function isChannel<TChannel extends Channel<any, any, any>>(
  channel: { readonly kind?: string },
  target: TChannel,
): channel is { readonly kind: `channel:${string}` };
export function isChannel(
  channel: { readonly kind?: string },
  target: Channel<any, any, any>,
): boolean {
  return channel.kind === getChannelInstrumentationKind(target);
}

export { answerFromText } from "#channel/resolve-text.js";

export type { UploadPolicyInput } from "#public/channels/upload-policy.js";
