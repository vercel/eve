import type { ChannelAdapter } from "#channel/adapter.js";
import type { RouteDefinition, SendFn } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";

export const CHANNEL_SENTINEL = "eve:channel" as const;
const CHANNEL_INSTRUMENTATION_KIND = Symbol.for("eve.channel.instrumentationKind");

export interface CompiledChannel<
  TState = undefined,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly __kind: typeof CHANNEL_SENTINEL;
  readonly routes: readonly RouteDefinition<TState>[];
  readonly adapter: ChannelAdapter<any>;
  readonly __metadata?: TMetadata;
  readonly receive?: (
    input: {
      readonly message: string;
      readonly target: Readonly<TReceiveTarget>;
      readonly auth: SessionAuthContext | null;
    },
    args: { send: SendFn<TState> },
  ) => Promise<Session>;
}

export function isCompiledChannel(value: unknown): value is CompiledChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === "eve:channel"
  );
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
  return typeof adapterKind === "string" && adapterKind.startsWith("channel:")
    ? adapterKind
    : undefined;
}

export function setChannelInstrumentationKind(channel: CompiledChannel, kind: string): void {
  Object.defineProperty(channel, CHANNEL_INSTRUMENTATION_KIND, {
    configurable: true,
    enumerable: false,
    value: kind,
  });
}
