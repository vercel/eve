import type { ChannelAdapter } from "#channel/adapter.js";
import type { ProgressSnapshotV1 } from "#protocol/progress.js";

const CHANNEL_PROGRESS_PRESENTATION = Symbol.for("eve.channel.progressPresentation");

export interface ChannelProgressRenderer {
  readonly id: string;
  render(input: {
    readonly destination: Readonly<Record<string, unknown>>;
    readonly snapshot: ProgressSnapshotV1;
    readonly state: unknown;
  }): Promise<unknown>;
  dispose?(input: {
    readonly destination: Readonly<Record<string, unknown>>;
    readonly state: unknown;
  }): Promise<void>;
}

export interface ChannelProgressPresentation {
  readonly destination: (
    state: Record<string, unknown> | undefined,
  ) => Readonly<Record<string, unknown>>;
  readonly renderers: readonly ChannelProgressRenderer[];
}

type ProgressChannelAdapter = ChannelAdapter & {
  readonly [CHANNEL_PROGRESS_PRESENTATION]?: ChannelProgressPresentation;
};

export function attachChannelProgressPresentation(
  adapter: ChannelAdapter,
  presentation: ChannelProgressPresentation,
): void {
  Object.defineProperty(adapter, CHANNEL_PROGRESS_PRESENTATION, {
    configurable: true,
    enumerable: false,
    value: presentation,
  });
}

export function copyChannelProgressPresentation(
  source: ChannelAdapter,
  target: ChannelAdapter,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, CHANNEL_PROGRESS_PRESENTATION);
  if (descriptor !== undefined) {
    Object.defineProperty(target, CHANNEL_PROGRESS_PRESENTATION, descriptor);
  }
}

export function getChannelProgressPresentation(
  adapter: ChannelAdapter,
): ChannelProgressPresentation | undefined {
  return (adapter as ProgressChannelAdapter)[CHANNEL_PROGRESS_PRESENTATION];
}
