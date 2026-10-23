import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import {
  type ChannelReceiveContext,
  createChannelOperations,
} from "#channel/channel-operations.js";
import {
  isCompiledChannel,
  type ChannelReference,
  type CompiledChannel,
} from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import type { Session } from "#channel/session.js";
import type { Runtime, SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

/**
 * Options for sending a message to a channel selected with `ctx.to(...)`.
 */
export interface CrossChannelSendOptions {
  readonly auth: SessionAuthContext | null;
  /** Prior conversation added before the message, as on `send()`. */
  readonly history?: readonly SessionHistoryMessage[];
  readonly turnPolicy?: TurnPolicy;
}

/** Message delivery bound to one channel-specific proactive target. */
export interface CrossChannelTargetHandle {
  /** Starts a session at the target, or continues the one that owns it. */
  send(message: string | UserContent, options: CrossChannelSendOptions): Promise<Session>;
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
 * Builds the `ctx.to(channel, target)` closure used by route and schedule handlers.
 */
export function createCrossChannelToFn(
  runtime: Runtime,
  channels: readonly CrossChannelTarget[],
): CrossChannelToFn {
  return (channel, target) =>
    createCrossChannelTargetHandle(runtime, resolveTargetByReference(channel, channels), target);
}

/**
 * Sends to a channel found by its path-derived name, as workflow tool bodies
 * address channels with `ctx.sendToChannel()`.
 */
export async function sendToNamedChannel(
  runtime: Runtime,
  channels: readonly CrossChannelTarget[],
  name: string,
  input: InvokeChannelReceiveInput["input"],
  options: Pick<InvokeChannelReceiveInput, "idempotencyKey" | "turnPolicy"> = {},
): Promise<Session> {
  const channel = channels.find((candidate) => candidate.name === name);
  if (channel === undefined) {
    const available = channels.map((candidate) => `"${candidate.name}"`).join(", ");
    throw new Error(
      `ctx.sendToChannel(): no channel named "${name}". Pass the path-derived name of a file in agent/channels/` +
        (available === "" ? "; this agent has no channels." : `: ${available}.`),
    );
  }
  return await invokeChannelReceive({
    caller: "ctx.sendToChannel()",
    idempotencyKey: options.idempotencyKey,
    input,
    runtime,
    target: channel,
    turnPolicy: options.turnPolicy,
  });
}

function createCrossChannelTargetHandle(
  runtime: Runtime,
  channel: CrossChannelTarget,
  target: unknown,
): CrossChannelTargetHandle {
  return {
    async send(message, options) {
      return await invokeChannelReceive({
        caller: "ctx.to()",
        runtime,
        target: channel,
        input: {
          auth: options.auth,
          history: options.history,
          message,
          target: target as Readonly<Record<string, unknown>>,
        },
        turnPolicy: options.turnPolicy,
      });
    },
  };
}

interface InvokeChannelReceiveInput {
  /** The API the author called, named in errors. */
  readonly caller: string;
  /**
   * Stable identity for this handoff. Each `from().send()` the channel makes
   * without its own key derives one from it, so a retried handoff to an address
   * that already has a session is deduplicated there.
   */
  readonly idempotencyKey?: string;
  readonly runtime: Runtime;
  readonly target: Pick<CrossChannelTarget, "name" | "receive" | "adapter" | "turnPolicy">;
  readonly input: {
    readonly auth: SessionAuthContext | null;
    readonly caller?: { readonly sessionId: string };
    readonly history?: readonly SessionHistoryMessage[];
    readonly message: string | UserContent;
    readonly target: Readonly<Record<string, unknown>>;
  };
  readonly turnPolicy?: TurnPolicy;
}

/**
 * Shared authored `receive(input, ctx)` invocation used by route, schedule,
 * and workflow tool delivery.
 */
async function invokeChannelReceive(args: InvokeChannelReceiveInput): Promise<Session> {
  const { name } = args.target;
  if (!args.target.receive) {
    throw new Error(
      `${args.caller}: channel "${name}" does not implement receive(). ` +
        `Declare a receive hook on the channel to accept cross-channel sessions.`,
    );
  }
  if (!args.target.adapter) {
    throw new Error(`${args.caller}: channel "${name}" has no adapter — cannot build ctx.from().`);
  }
  const channelOperations = createChannelOperations({
    adapter: args.target.adapter,
    channelName: name,
    runtime: args.runtime,
    turnPolicy: args.turnPolicy ?? args.target.turnPolicy,
  });
  return await args.target.receive(
    args.input,
    withHandoffDefaults(channelOperations, {
      history: args.input.history,
      idempotencyKey: args.idempotencyKey,
    }),
  );
}

/**
 * The handoff's `history` and idempotency key join the channel's `send()`
 * calls unless the channel passed its own.
 */
function withHandoffDefaults(
  operations: ChannelReceiveContext,
  defaults: {
    readonly history: readonly SessionHistoryMessage[] | undefined;
    readonly idempotencyKey: string | undefined;
  },
): ChannelReceiveContext {
  if (defaults.history === undefined && defaults.idempotencyKey === undefined) return operations;
  // Numbering keeps two sends from one `receive()` distinct; a deterministic
  // `receive()` numbers them the same on retry.
  let sends = 0;
  return {
    ...operations,
    from(address) {
      const source = operations.from(address);
      return {
        ...source,
        async send(message, options) {
          const sendIndex = sends++;
          return await source.send(message, {
            ...options,
            history: options.history ?? defaults.history,
            idempotencyKey:
              options.idempotencyKey ??
              (defaults.idempotencyKey === undefined
                ? undefined
                : `${defaults.idempotencyKey}:${sendIndex}`),
          });
        },
      };
    },
  };
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
