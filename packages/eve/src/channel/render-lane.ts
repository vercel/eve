import type { ChannelAdapterContext } from "#channel/adapter.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";

/** What one render of a channel's lane leaves behind. */
export interface ChannelRenderResult {
  /** The lane's own state, handed to its next render. JSON only. */
  readonly lane: unknown;
  /** Render again after this long even when channel state hasn't changed. */
  readonly wakeInMs?: number;
}

/**
 * Rendering a channel does outside its session's turn steps. The session's
 * workflow runs `render` in its own step after steps that changed what
 * `revision` reads, and again when a render asks to wake, one render at a
 * time. A render reads channel state committed before it started and never
 * changes it; what it needs to remember goes in its lane state.
 */
export interface ChannelRenderLane<
  TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext,
> {
  /** Changes whenever state `render` reads changes; `undefined` when there is nothing to render. */
  revision(state: Record<string, unknown>): string | undefined;
  /** Renders from committed channel state. Must not throw. */
  render(input: { readonly channel: TCtx; readonly lane: unknown }): Promise<ChannelRenderResult>;
}

/**
 * Attaches a render lane to a channel an eve factory built, typed by the
 * channel's own adapter context, which the lane's render receives.
 */
export function attachChannelRenderLane<TCtx extends ChannelAdapterContext<any>>(
  channel: CompiledChannel,
  lane: ChannelRenderLane<TCtx>,
): void {
  // The adapter is still being built, so its readonly lane is set here, once.
  (channel.adapter as { renderLane?: ChannelRenderLane<TCtx> }).renderLane = lane;
}
