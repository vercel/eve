import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelRenderResult } from "#channel/render-lane.js";
import { contextStorage } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { createLogger, logError } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.render-lane");

/** A render that failed tries again after this long. */
const RETRY_AFTER_FAILURE_MS = 5_000;

/**
 * Runs the session channel's render lane against a committed context snapshot.
 * Channel state the render changes is discarded: only the lane state it
 * returns survives. Never throws, so a broken render can't fail the session.
 */
export async function renderChannelLaneStep(input: {
  readonly lane: unknown;
  readonly serializedContext: Record<string, unknown>;
}): Promise<ChannelRenderResult> {
  "use step";
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.require(ChannelKey);
    const renderLane = adapter.renderLane;
    if (renderLane === undefined) return { lane: input.lane };
    return await contextStorage.run(ctx, () =>
      renderLane.render({ channel: buildAdapterContext(adapter, ctx), lane: input.lane }),
    );
  } catch (error) {
    logError(log, "channel render failed", error);
    return { lane: input.lane, wakeInMs: RETRY_AFTER_FAILURE_MS };
  }
}
