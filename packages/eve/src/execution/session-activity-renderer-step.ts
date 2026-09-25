import { getChannelActivityPresentation } from "#channel/activity-renderer.js";
import { deserializeContext } from "#context/serialize.js";
import type { ActivitySnapshotV1 } from "#protocol/activity.js";
import { createLogger, logError } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.session-activity-renderer");

export interface SessionActivityRenderState {
  readonly rendererStates: Readonly<Record<string, unknown>>;
}

/** Runs channel-owned activity effects from collector-owned immutable context. */
export async function renderSessionActivityStep(input: {
  readonly rendererStates: Readonly<Record<string, unknown>>;
  readonly serializedContext: Record<string, unknown>;
  readonly snapshot: ActivitySnapshotV1;
}): Promise<SessionActivityRenderState> {
  "use step";

  const { adapter, destination, presentation } = await resolveActivityPresentation(
    input.serializedContext,
  );
  const rendererStates: Record<string, unknown> = { ...input.rendererStates };
  for (const renderer of presentation.renderers) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        rendererStates[renderer.id] = await renderer.render({
          destination,
          snapshot: input.snapshot,
          state: rendererStates[renderer.id],
        });
        break;
      } catch (error) {
        logError(log, "activity renderer failed", error, {
          adapterKind: adapter.kind,
          attempt: attempt + 1,
          rendererId: renderer.id,
          revision: input.snapshot.revision,
        });
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  return { rendererStates };
}

/** Best-effort cleanup of transient provider state when collector ownership expires. */
export async function disposeSessionActivityStep(input: {
  readonly rendererStates: Readonly<Record<string, unknown>>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const { adapter, destination, presentation } = await resolveActivityPresentation(
    input.serializedContext,
  );
  for (const renderer of presentation.renderers) {
    if (renderer.dispose === undefined) continue;
    try {
      await renderer.dispose({ destination, state: input.rendererStates[renderer.id] });
    } catch (error) {
      logError(log, "activity renderer disposal failed", error, {
        adapterKind: adapter.kind,
        rendererId: renderer.id,
      });
    }
  }
}

async function resolveActivityPresentation(serializedContext: Record<string, unknown>) {
  const ctx = await deserializeContext(serializedContext);
  const adapter = ctx.require(ChannelKey);
  const presentation = getChannelActivityPresentation(adapter);
  if (presentation === undefined) throw new Error("Channel has no activity presentation.");
  return {
    adapter,
    destination: presentation.destination(adapter.state),
    presentation,
  };
}
