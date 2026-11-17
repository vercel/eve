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

export interface ChannelRoutePorts {
  readonly runtime: Runtime;
  readonly adapter: ChannelAdapter;
  readonly deliverySource: ChannelDeliverySource;
  readonly turnPolicy?: TurnPolicy;
  readonly agentName: string;
  readonly params: Readonly<Record<string, string>>;
  readonly requestIp: string | null;
  readonly agent: Pick<
    RouteHandlerArgs,
    "describe" | "invokeTool" | "listSkillFiles" | "readSkill"
  >;
  readonly agentInfo: () => Promise<Response>;
  readonly to: CrossChannelToFn;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly skillFiles?: SkillFileSource;
  readonly remoteAgentStreamHeaders?: RemoteAgentStreamHeadersResolver;
}

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
      return {
        get events() {
          return handle.events;
        },
        sessionId: handle.sessionId,
        ...(handle.claimedContinuation !== undefined && {
          claimedContinuation: handle.claimedContinuation,
        }),
        deliveryId: delivery.deliveryId,
      };
    },
  );
  if (ports.skillFiles !== undefined) attachSkillFileSource(args, ports.skillFiles);
  if (ports.remoteAgentStreamHeaders !== undefined) {
    attachRemoteAgentStreamHeadersResolver(args, ports.remoteAgentStreamHeaders);
  }
  return args;
}
