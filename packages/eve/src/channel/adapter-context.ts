import type { ContextAccessor } from "#context/key.js";
import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import { buildChannelContext } from "#channel/session.js";

/**
 * Builds the {@link ChannelAdapterContext} the runtime hands to an
 * adapter's `deliver` hook, event handlers, and attachment resolver.
 *
 * Session metadata and channel continuation routing resolve live from the supplied accessor.
 */
export function buildAdapterContext<
  TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext,
>(adapter: ChannelAdapter<TCtx>, accessor: ContextAccessor): TCtx {
  // `adapter.state` is stored loosely (`Record<string, unknown>`)
  // because it round-trips through JSON at step boundaries. The
  // adapter is responsible for seeding state in the shape its
  // `createAdapterContext` / handlers expect, so the cast to the
  // narrower `TCtx`-derived state is safe at this seam.
  const channel = buildChannelContext(accessor);
  const baseCtx = {
    ctx: accessor,
    state: adapter.state ?? {},
    session: channel.session,
    get continuation() {
      return channel.continuation;
    },
  } as Parameters<NonNullable<ChannelAdapter<TCtx>["createAdapterContext"]>>[0];
  return adapter.createAdapterContext
    ? adapter.createAdapterContext(baseCtx)
    : (baseCtx as unknown as TCtx);
}
