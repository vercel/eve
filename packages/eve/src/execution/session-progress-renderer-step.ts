import { deserializeContext } from "#context/serialize.js";
import type { ProgressSnapshotV1 } from "#execution/session-progress.js";
import { createLogger, logError } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.session-progress-renderer");

export interface SessionProgressRenderState {
  readonly snapshot: ProgressSnapshotV1;
  readonly rendererStates: Readonly<Record<string, unknown>>;
}

/** Runs channel-owned progress effects without exposing turn-owned channel context. */
export async function renderSessionProgressStep(input: {
  readonly rendererStates: Readonly<Record<string, unknown>>;
  readonly serializedContext: Record<string, unknown>;
  readonly snapshot: ProgressSnapshotV1;
}): Promise<SessionProgressRenderState> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const renderers = adapter.progressRenderers ?? [];
  const destination = adapter.progressDestination?.(adapter.state) ?? {};
  const rendererStates: Record<string, unknown> = { ...input.rendererStates };

  for (const renderer of renderers) {
    try {
      rendererStates[renderer.id] = await renderer.render({
        destination,
        snapshot: input.snapshot,
        state: rendererStates[renderer.id],
      });
    } catch (error) {
      logError(log, "progress renderer failed", error, {
        adapterKind: adapter.kind,
        rendererId: renderer.id,
        revision: input.snapshot.revision,
      });
    }
  }

  return { rendererStates, snapshot: input.snapshot };
}
