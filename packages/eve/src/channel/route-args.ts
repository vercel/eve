import type { ChannelAdapter } from "#channel/adapter.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import type { CrossChannelToFn } from "#channel/cross-channel-receive.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { createAttachSessionFn } from "#channel/session.js";
import type { SkillFileSource } from "#channel/skill-files.js";
import type { Runtime, TurnPolicy } from "#channel/types.js";
import {
  attachAgentInfoRouteResponse,
  attachHomeRouteMetadata,
  attachRemoteAgentStreamHeadersResolver,
  attachRouteChannelName,
  attachRouteSessionCreator,
  attachSkillFileSource,
  type RemoteAgentStreamHeadersResolver,
} from "#internal/nitro/routes/channel-route-context.js";

/** What a host supplies for one request to a channel route, such as Nitro's dispatch. */
export interface ChannelRoutePorts {
  /** Where the channel's sessions run. */
  readonly runtime: Runtime;
  /** The adapter the channel's deliveries go through. */
  readonly adapter: ChannelAdapter;
  /** Where the request came from; its `channelName` namespaces continuation tokens. */
  readonly deliverySource: ChannelDeliverySource;
  readonly turnPolicy?: TurnPolicy;
  readonly agentName: string;
  readonly params: Readonly<Record<string, string>>;
  readonly requestIp: string | null;
  /** The agent as callers see it, and its tools outside a turn. */
  readonly agent: Pick<
    RouteHandlerArgs,
    "describe" | "invokeTool" | "listSkillFiles" | "readSkill"
  >;
  /** Answers `GET /eve/v1/info`. */
  readonly agentInfo: () => Promise<Response>;
  readonly to: CrossChannelToFn;
  /** Keeps work going after the response; the host logs a task that fails. */
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly skillFiles?: SkillFileSource;
  readonly remoteAgentStreamHeaders?: RemoteAgentStreamHeadersResolver;
}

/**
 * The arguments a channel route handler gets, from what its host supplies: the channel
 * operations, `attachSession`, and the framework's own fields that eve's channels read (the
 * session creator, `/info`, the channel and agent names, skill files, remote stream headers).
 */
export function createChannelRouteArgs(ports: ChannelRoutePorts): RouteHandlerArgs {
  const { adapter, deliverySource, runtime, turnPolicy } = ports;
  const { channelName } = deliverySource;
  const args = attachRouteSessionCreator(
    attachHomeRouteMetadata(
      attachRouteChannelName(
        attachAgentInfoRouteResponse(
          {
            attachSession: createAttachSessionFn(runtime, { ...deliverySource, turnPolicy }),
            ...createChannelOperations({
              adapter,
              channelName,
              metadata: deliverySource,
              runtime,
              turnPolicy,
            }),
            ...ports.agent,
            params: ports.params,
            requestIp: ports.requestIp,
            to: ports.to,
            waitUntil: ports.waitUntil,
          },
          ports.agentInfo,
        ),
        channelName,
      ),
      { agentName: ports.agentName },
    ),
    async ({ deliveryId, ...input }) => {
      const generated = createChannelDeliveryMetadata(deliverySource);
      const delivery = deliveryId === undefined ? generated : { ...generated, deliveryId };
      const handle = await runtime.createSession({
        ...input,
        adapter,
        channelName,
        continuationToken:
          input.continuationToken === undefined
            ? undefined
            : `${channelName}:${input.continuationToken}`,
        delivery,
        requestId: deliverySource.requestId,
      });
      return { ...handle, deliveryId: delivery.deliveryId };
    },
  );
  if (ports.skillFiles !== undefined) attachSkillFileSource(args, ports.skillFiles);
  if (ports.remoteAgentStreamHeaders !== undefined) {
    attachRemoteAgentStreamHeadersResolver(args, ports.remoteAgentStreamHeaders);
  }
  return args;
}
