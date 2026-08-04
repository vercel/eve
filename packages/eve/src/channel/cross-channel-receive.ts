import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import type { Session } from "#channel/session.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

/**
 * Options for sending a message to a channel selected with `ctx.to(...)`.
 */
export interface CrossChannelSendOptions {
  readonly auth: SessionAuthContext | null;
}

/** Message delivery bound to one channel-specific proactive target. */
export interface CrossChannelTargetHandle {
  send(message: string | UserContent, options: CrossChannelSendOptions): Promise<Session>;
}

/** Selects another authored channel and one of its proactive targets. */
export type CrossChannelToFn = <TChannel>(
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
}

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
          },
        ],
  );
}

/**
 * Builds the `ctx.to(channel, target)` closure used by route and schedule handlers.
 */
export function createCrossChannelToFn(
  runtime: Runtime,
  channels: readonly CrossChannelTarget[],
): CrossChannelToFn {
  return (channel, target) => {
    const targetChannel = resolveTargetByReference(channel, channels);
    return {
      async send(message, options) {
        return await invokeChannelReceive({
          runtime,
          target: targetChannel,
          input: {
            message,
            target: target as Readonly<Record<string, unknown>>,
            auth: options.auth,
          },
          describeMissingReceive: () =>
            `ctx.to(): channel "${targetChannel.name}" does not implement receive(). ` +
            `Declare a receive hook on the channel to accept cross-channel sessions.`,
          describeMissingAdapter: () =>
            `ctx.to(): channel "${targetChannel.name}" has no adapter — cannot build ctx.from().`,
        });
      },
    };
  };
}

interface InvokeChannelReceiveInput {
  readonly runtime: Runtime;
  readonly target: Pick<CrossChannelTarget, "name" | "receive" | "adapter">;
  readonly input: {
    readonly message: string | UserContent;
    readonly target: Readonly<Record<string, unknown>>;
    readonly auth: SessionAuthContext | null;
  };
  readonly describeMissingReceive: () => string;
  readonly describeMissingAdapter: () => string;
}

/**
 * Shared authored `receive(input, ctx)` invocation used by route and schedule delivery.
 */
export async function invokeChannelReceive(args: InvokeChannelReceiveInput): Promise<Session> {
  if (!args.target.receive) {
    throw new Error(args.describeMissingReceive());
  }
  if (!args.target.adapter) {
    throw new Error(args.describeMissingAdapter());
  }
  const channelOperations = createChannelOperations({
    adapter: args.target.adapter,
    channelName: args.target.name,
    runtime: args.runtime,
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
