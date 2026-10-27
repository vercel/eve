import type { MessageContent } from "#shared/message-content.js";

import type { ChannelAdapter } from "#channel/adapter.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import {
  isCompiledChannel,
  type ChannelReference,
  type CompiledChannel,
} from "#channel/compiled-channel.js";
import type { ChannelDeliverySource } from "#channel/delivery-metadata.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import { toSessionSendOptions, type SessionSendOptions } from "#channel/session.js";
import type { GenericReceiveInput } from "#shared/channel-definition.js";
import type { Delivery } from "#shared/delivery.js";
import type { Runtime, TurnPolicy } from "#channel/types.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

/** Message delivery bound to one channel-specific proactive target. */
export interface CrossChannelTargetHandle {
  /**
   * Starts a session at the target, or continues the one that owns it. The
   * channel's `receive()` hook gets `options` with the message and target.
   */
  send(message: MessageContent, options: SessionSendOptions): Promise<Delivery>;
}

/** Selects another authored channel and one of its proactive targets. */
export type CrossChannelToFn = <TChannel extends ChannelReference<unknown>>(
  channel: TChannel,
  target: InferReceiveTarget<TChannel>,
) => CrossChannelTargetHandle;

/**
 * Channel record consumed by the receiver — keeps the public-facing
 * `definition` reference so callers can identify a target by value
 * (the same module-default they imported in their route file).
 */
export interface CrossChannelTarget {
  readonly name: string;
  readonly definition: CompiledChannel;
  readonly receive?: CompiledChannel["receive"];
  readonly adapter?: ChannelAdapter;
  readonly turnPolicy?: CompiledChannel["turnPolicy"];
}

/** What a forwarded delivery inherits from the caller; the target channel supplies its own name. */
type CrossChannelDeliverySource = Omit<ChannelDeliverySource, "channelKind" | "channelName">;

/**
 * Projects an agent's resolved channels into the receiver-input shape.
 *
 * Framework-internal fetch-only channels carry no `definition` reference
 * and are filtered out at this boundary — only authored channels backed
 * by a `defineChannel` value can be receive targets.
 */
export function toCrossChannelTargets(
  channels: readonly ResolvedChannelDefinition[],
): readonly CrossChannelTarget[] {
  return channels.flatMap((channel) =>
    channel.definition === undefined
      ? []
      : [
          {
            name: channel.name,
            definition: channel.definition,
            receive: channel.receive,
            adapter: channel.adapter,
            turnPolicy: channel.turnPolicy,
          },
        ],
  );
}

/**
 * Builds the `ctx.to(channel, target)` closure used by route and schedule
 * handlers and tools.
 */
export function createCrossChannelToFn(
  runtime: Runtime,
  channels: readonly CrossChannelTarget[],
  source: CrossChannelDeliverySource = {},
): CrossChannelToFn {
  return (channel, target) => {
    const targetChannel = resolveTargetByReference(channel, channels);
    return {
      async send(message, sendOptions) {
        return await invokeChannelReceive({
          runtime,
          source,
          target: targetChannel,
          input: {
            ...toSessionSendOptions(sendOptions),
            message,
            target: target as Readonly<Record<string, unknown>>,
          },
          turnPolicy: sendOptions.turnPolicy,
        });
      },
    };
  };
}

interface InvokeChannelReceiveInput {
  readonly runtime: Runtime;
  readonly source: CrossChannelDeliverySource;
  readonly target: Pick<CrossChannelTarget, "name" | "receive" | "adapter" | "turnPolicy">;
  readonly input: GenericReceiveInput;
  readonly turnPolicy?: TurnPolicy;
}

/** Shared authored `receive(input, ctx)` invocation behind every `ctx.to()`. */
async function invokeChannelReceive(args: InvokeChannelReceiveInput): Promise<Delivery> {
  const { name } = args.target;
  if (!args.target.receive) {
    throw new Error(
      `ctx.to(): channel "${name}" does not implement receive(). ` +
        `Declare a receive hook on the channel to accept cross-channel sessions.`,
    );
  }
  if (!args.target.adapter) {
    throw new Error(`ctx.to(): channel "${name}" has no adapter — cannot build ctx.from().`);
  }
  const channelOperations = createChannelOperations({
    adapter: args.target.adapter,
    channelName: name,
    metadata: { ...args.source, channelKind: `channel:${name}`, channelName: name },
    runtime: args.runtime,
    turnPolicy: args.turnPolicy ?? args.target.turnPolicy,
  });
  return await args.target.receive(args.input, channelOperations);
}

function resolveTargetByReference(
  ref: unknown,
  channels: readonly CrossChannelTarget[],
): CrossChannelTarget {
  for (const channel of channels) {
    if (channel.definition === ref) {
      return channel;
    }
  }
  const structurallyMatchedTarget = resolveTargetByRouteFingerprint(ref, channels);
  if (structurallyMatchedTarget !== null) {
    return structurallyMatchedTarget;
  }
  throw new Error(
    "ctx.to(): the channel passed as the first argument is not registered " +
      "in this agent's channels/. Import the channel module's default export from " +
      "agent/channels/<name>.ts and pass that value.",
  );
}

function resolveTargetByRouteFingerprint(
  ref: unknown,
  channels: readonly CrossChannelTarget[],
): CrossChannelTarget | null {
  if (!isCompiledChannel(ref)) {
    return null;
  }

  const refFingerprint = createRouteFingerprint(ref);
  if (refFingerprint === null) {
    return null;
  }

  const matches = new Map<string, CrossChannelTarget>();

  for (const channel of channels) {
    if (createRouteFingerprint(channel.definition) !== refFingerprint) {
      continue;
    }
    matches.set(channel.name, channel);
  }

  if (matches.size === 1) {
    return [...matches.values()][0]!;
  }
  if (matches.size > 1) {
    throw new Error(
      "ctx.to(): the channel passed as the first argument matches multiple " +
        "registered channels by route shape. Import a channel with a unique route set " +
        "from agent/channels/<name>.ts before passing it to ctx.to().",
    );
  }

  return null;
}

function createRouteFingerprint(channel: CompiledChannel): string | null {
  if (channel.routes.length === 0) {
    return null;
  }

  const routes = channel.routes
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .sort();
  return routes.join("\n");
}
