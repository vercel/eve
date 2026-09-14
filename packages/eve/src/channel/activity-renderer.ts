import type { ChannelAdapter } from "#channel/adapter.js";
import type { ActivitySnapshotV1 } from "#protocol/activity.js";

const CHANNEL_ACTIVITY_PRESENTATION = Symbol.for("eve.channel.activityPresentation");

export interface ChannelActivityRenderer {
  readonly id: string;
  render(input: {
    readonly destination: Readonly<Record<string, unknown>>;
    readonly snapshot: ActivitySnapshotV1;
    readonly state: unknown;
  }): Promise<unknown>;
  dispose?(input: {
    readonly destination: Readonly<Record<string, unknown>>;
    readonly state: unknown;
  }): Promise<void>;
}

export interface ChannelActivityPresentation {
  readonly destination: (
    state: Record<string, unknown> | undefined,
  ) => Readonly<Record<string, unknown>>;
  readonly renderers: readonly ChannelActivityRenderer[];
}

type ActivityChannelAdapter = ChannelAdapter & {
  readonly [CHANNEL_ACTIVITY_PRESENTATION]?: ChannelActivityPresentation;
};

export function attachChannelActivityPresentation(
  adapter: ChannelAdapter,
  presentation: ChannelActivityPresentation,
): void {
  Object.defineProperty(adapter, CHANNEL_ACTIVITY_PRESENTATION, {
    configurable: true,
    enumerable: false,
    value: presentation,
  });
}

export function copyChannelActivityPresentation(
  source: ChannelAdapter,
  target: ChannelAdapter,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, CHANNEL_ACTIVITY_PRESENTATION);
  if (descriptor !== undefined) {
    Object.defineProperty(target, CHANNEL_ACTIVITY_PRESENTATION, descriptor);
  }
}

export function getChannelActivityPresentation(
  adapter: ChannelAdapter,
): ChannelActivityPresentation | undefined {
  return (adapter as ActivityChannelAdapter)[CHANNEL_ACTIVITY_PRESENTATION];
}
