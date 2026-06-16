import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import { createSendFn } from "#channel/send.js";
import type { Session } from "#channel/session.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

/**
 * Options accepted by {@link CrossChannelReceiveFn}. Mirrors the input
 * argument of a channel's authored `receive(input, { send })` hook —
 * the runtime constructs `send` internally so route-handler callers
 * only supply the platform target, payload, and auth.
 */
export interface CrossChannelReceiveOptions<TTarget = Record<string, unknown>> {
  readonly message: string | UserContent;
  readonly target: TTarget;
  readonly auth: SessionAuthContext | null;
}

/**
 * Starts a session on a different channel from inside a route handler.
 * The target channel's authored `receive` hook owns continuation-token
 * format and initial state; `auth` is forwarded verbatim and becomes
 * `session.initiatorAuth`.
 */
export type CrossChannelReceiveFn = <TChannel>(
  channel: TChannel,
  options: CrossChannelReceiveOptions<InferReceiveTarget<TChannel>>,
) => Promise<Session>;

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
 * Builds the `args.receive` closure used by every route handler. The
 * closure resolves the target channel by reference identity against
 * the request-scoped channel bundle, then delegates to the target's
 * authored `receive` hook with a per-target `send` factory.
 */
export function createCrossChannelReceiveFn(
  runtime: Runtime,
  channels: readonly CrossChannelTarget[],
): CrossChannelReceiveFn {
  return async (channel, options) => {
    const targetChannel = resolveTargetByReference(channel, channels);
    return await invokeChannelReceive({
      runtime,
      target: targetChannel,
      input: {
        message: options.message as string,
        target: options.target as Readonly<Record<string, unknown>>,
        auth: options.auth,
      },
      describeMissingReceive: () =>
        `args.receive(): channel "${targetChannel.name}" does not implement receive(). ` +
        `Declare a receive hook on the channel to accept cross-channel sessions.`,
      describeMissingAdapter: () =>
        `args.receive(): channel "${targetChannel.name}" has no adapter — cannot build send().`,
    });
  };
}

interface InvokeChannelReceiveInput {
  readonly runtime: Runtime;
  readonly target: Pick<CrossChannelTarget, "name" | "receive" | "adapter">;
  readonly input: {
    readonly message: string;
    readonly target: Readonly<Record<string, unknown>>;
    readonly auth: SessionAuthContext | null;
  };
  readonly describeMissingReceive: () => string;
  readonly describeMissingAdapter: () => string;
}

/**
 * Shared `receive(input, { send })` invocation used by both the route-
 * handler cross-channel surface and the schedule dispatcher. Owns the
 * receive/adapter precondition checks and the per-target `send`
 * factory so both call sites stay byte-identical.
 */
export async function invokeChannelReceive(args: InvokeChannelReceiveInput): Promise<Session> {
  if (!args.target.receive) {
    throw new Error(args.describeMissingReceive());
  }
  if (!args.target.adapter) {
    throw new Error(args.describeMissingAdapter());
  }
  const send = createSendFn(args.runtime, args.target.adapter, args.target.name);
  return await args.target.receive(args.input, { send });
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
    "args.receive(): the channel passed as the first argument is not registered " +
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
      "args.receive(): the channel passed as the first argument matches multiple " +
        "registered channels by route shape. Import a channel with a unique route set " +
        "from agent/channels/<name>.ts before passing it to args.receive().",
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
