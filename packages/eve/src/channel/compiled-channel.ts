import type { ChannelAdapter } from "#channel/adapter.js";
import type { ChannelReceiveContext } from "#channel/channel-operations.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { TypedReceiveTarget } from "#channel/receive-target.js";
import type { RouteDefinition } from "#channel/routes.js";
import type { Delivery } from "#shared/delivery.js";
import type { TurnPolicy } from "#channel/types.js";
import type { GenericReceiveInput } from "#shared/channel-definition.js";
import type { JsonObject } from "#shared/json.js";

export const CHANNEL_SENTINEL = "eve:channel" as const;
const CHANNEL_BUILD_METADATA = Symbol.for("eve.channel.buildMetadata");
const CHANNEL_START_HOOK = Symbol.for("eve.channel.startHook");
const CHANNEL_INSTRUMENTATION_KIND = Symbol.for("eve.channel.instrumentationKind");
const CHANNEL_INSTRUMENTATION_KINDS = Symbol.for("eve.channel.instrumentationKinds");

// Nitro dev can evaluate a channel once for its route and again for a resolver
// import, so separately created channel objects need a process-wide identity.
type ChannelInstrumentationKindGlobal = typeof globalThis & {
  [CHANNEL_INSTRUMENTATION_KINDS]?: Map<string, string>;
};

const channelInstrumentationKindGlobal = globalThis as ChannelInstrumentationKindGlobal;
channelInstrumentationKindGlobal[CHANNEL_INSTRUMENTATION_KINDS] ??= new Map();
const channelInstrumentationKinds = channelInstrumentationKindGlobal[CHANNEL_INSTRUMENTATION_KINDS];

interface ChannelBuildMetadata {
  readonly externalCredentials?: unknown;
  readonly manifest?: JsonObject;
}

type ChannelBuildMetadataFactory = (channelName: string) => ChannelBuildMetadata;

/** Structural identity shared by public authored channels and compiled channels. */
export interface ChannelReference<
  TReceiveTarget = Record<string, unknown>,
> extends TypedReceiveTarget<TReceiveTarget> {
  readonly __kind: typeof CHANNEL_SENTINEL;
}

export interface CompiledChannel<
  TState = undefined,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ChannelReference<TReceiveTarget> {
  readonly routes: readonly RouteDefinition<TState>[];
  readonly adapter: ChannelAdapter<any>;
  readonly cors?: NormalizedChannelCorsOptions;
  readonly __metadata?: TMetadata;
  readonly receive?: (
    input: GenericReceiveInput<TReceiveTarget>,
    ctx: ChannelReceiveContext<TState>,
  ) => Promise<Delivery>;
  readonly turnPolicy?: TurnPolicy;
}

export function isCompiledChannel(value: unknown): value is CompiledChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === "eve:channel"
  );
}

export function getChannelBuildMetadata(
  value: unknown,
  channelName: string,
): ChannelBuildMetadata | undefined {
  if (!isCompiledChannel(value)) return undefined;
  const factory = Reflect.get(value, CHANNEL_BUILD_METADATA);
  return typeof factory === "function"
    ? (factory as ChannelBuildMetadataFactory)(channelName)
    : undefined;
}

export function setChannelBuildMetadata(
  channel: unknown,
  factory: ChannelBuildMetadataFactory,
): void {
  if (!isCompiledChannel(channel)) throw new TypeError("Expected a compiled channel.");
  // Enumerable so `{ ...channel, routes }` keeps build metadata when an app
  // wraps a channel's routes.
  Object.defineProperty(channel, CHANNEL_BUILD_METADATA, {
    configurable: true,
    enumerable: true,
    value: factory,
  });
}

/** What a channel's start hook gets: the request that loaded the runtime, and its `waitUntil`. */
export interface ChannelStartContext {
  readonly request: Request;
  waitUntil(task: Promise<unknown>): void;
}

export type ChannelStartHook = (ctx: ChannelStartContext) => void;

/**
 * Runs `hook` once per loaded runtime, on the first request it serves, whichever route that
 * is. Internal: for built-in channels that must reach their platform before any of their own
 * routes is called, such as registering where the platform wakes them.
 */
export function setChannelStartHook(channel: unknown, hook: ChannelStartHook): void {
  if (!isCompiledChannel(channel)) throw new TypeError("Expected a compiled channel.");
  // Enumerable so `{ ...channel, routes }` keeps the hook when an app wraps a channel's routes.
  Object.defineProperty(channel, CHANNEL_START_HOOK, {
    configurable: true,
    enumerable: true,
    value: hook,
  });
}

export function getChannelStartHook(value: unknown): ChannelStartHook | undefined {
  if (!isCompiledChannel(value)) return undefined;
  const hook = Reflect.get(value, CHANNEL_START_HOOK);
  return typeof hook === "function" ? (hook as ChannelStartHook) : undefined;
}

export function getChannelInstrumentationKind(value: unknown): string | undefined {
  if (!isCompiledChannel(value)) {
    return undefined;
  }

  const stampedKind = Reflect.get(value, CHANNEL_INSTRUMENTATION_KIND);
  if (typeof stampedKind === "string" && stampedKind.length > 0) {
    return stampedKind;
  }

  const adapterKind = value.adapter.kind;
  if (typeof adapterKind === "string" && adapterKind.startsWith("channel:")) {
    return adapterKind;
  }

  const routeSignature = channelRouteSignature(value);
  return routeSignature === undefined ? undefined : channelInstrumentationKinds.get(routeSignature);
}

export function setChannelInstrumentationKind(channel: CompiledChannel, kind: string): void {
  Object.defineProperty(channel, CHANNEL_INSTRUMENTATION_KIND, {
    configurable: true,
    enumerable: false,
    value: kind,
  });
  const routeSignature = channelRouteSignature(channel);
  if (routeSignature !== undefined) {
    channelInstrumentationKinds.set(routeSignature, kind);
  }
}

function channelRouteSignature(channel: CompiledChannel): string | undefined {
  if (channel.routes.length === 0) return undefined;
  return channel.routes
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .sort()
    .join("\n");
}
