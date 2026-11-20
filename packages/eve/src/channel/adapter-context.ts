import type { ContextAccessor } from "#context/key.js";
import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import { buildChannelContext } from "#channel/session.js";

export function buildAdapterContext<
  TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext,
>(adapter: ChannelAdapter<TCtx>, accessor: ContextAccessor): TCtx {
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
