import { buildAdapterContext } from "#channel/adapter-context.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export interface RefreshChannelStatusResult {
  readonly delayMs?: number;
  readonly serializedContext: Record<string, unknown>;
}

/** Refreshes a channel-owned status while its turn waits durably. */
export async function refreshChannelStatusStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<RefreshChannelStatusResult> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const refresh = adapter.statusKeepalive?.refresh;
  if (refresh === undefined) {
    return { serializedContext: input.serializedContext };
  }

  const adapterCtx = buildAdapterContext(adapter, ctx);
  let delayMs: number | undefined;
  try {
    delayMs = await refresh(adapterCtx);
  } catch {
    // Channel statuses are cosmetic and never fail an active turn.
  }
  ctx.set(ChannelKey, { ...adapter, state: { ...adapterCtx.state } });
  return { delayMs, serializedContext: serializeContext(ctx) };
}
