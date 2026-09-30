import { getChannelActivityPresenter } from "#channel/activity-presenter.js";
import { deserializeContext } from "#context/serialize.js";
import type { ActivitySnapshotV1 } from "#protocol/activity.js";
import { createLogger, logError } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.session-activity-presenter");

/**
 * Renders one snapshot through the channel's activity presenter and returns the
 * presenter's next state. A failed render is retried once, then logged and
 * skipped, keeping the previous state so the next snapshot starts from it.
 */
export async function renderSessionActivityStep(input: {
  readonly presenterState: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly snapshot: ActivitySnapshotV1;
}): Promise<unknown> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const presenter = getChannelActivityPresenter(adapter);
  if (presenter === undefined) return input.presenterState;
  const destination = presenter.destination(adapter.state);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await presenter.render({
        destination,
        snapshot: input.snapshot,
        state: input.presenterState,
      });
    } catch (error) {
      logError(log, "activity presenter failed", error, {
        adapterKind: adapter.kind,
        attempt,
        revision: input.snapshot.revision,
      });
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return input.presenterState;
}
