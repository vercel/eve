import type { ChannelAdapter } from "#channel/adapter.js";
import type { ActivitySnapshotV1 } from "#protocol/activity.js";

const CHANNEL_ACTIVITY_PRESENTER = Symbol.for("eve.channel.activityPresenter");

/**
 * A channel's live view of a root session's activity, rendered by the session's
 * activity collector off the turn's critical path. The collector keeps the
 * presenter's state between renders and never lets a failure reach the turn.
 */
export interface ChannelActivityPresenter {
  /** Where to render, read once from the channel state when the collector starts. */
  destination(state: Record<string, unknown> | undefined): Readonly<Record<string, unknown>>;
  render(input: {
    readonly destination: Readonly<Record<string, unknown>>;
    readonly snapshot: ActivitySnapshotV1;
    readonly state: unknown;
  }): Promise<unknown>;
}

type PresentingChannelAdapter = ChannelAdapter & {
  readonly [CHANNEL_ACTIVITY_PRESENTER]?: ChannelActivityPresenter;
};

export function attachChannelActivityPresenter(
  adapter: ChannelAdapter,
  presenter: ChannelActivityPresenter,
): void {
  Object.defineProperty(adapter, CHANNEL_ACTIVITY_PRESENTER, {
    configurable: true,
    enumerable: false,
    value: presenter,
  });
}

export function copyChannelActivityPresenter(source: ChannelAdapter, target: ChannelAdapter): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, CHANNEL_ACTIVITY_PRESENTER);
  if (descriptor !== undefined) {
    Object.defineProperty(target, CHANNEL_ACTIVITY_PRESENTER, descriptor);
  }
}

export function getChannelActivityPresenter(
  adapter: ChannelAdapter,
): ChannelActivityPresenter | undefined {
  return (adapter as PresentingChannelAdapter)[CHANNEL_ACTIVITY_PRESENTER];
}
