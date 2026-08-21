import { getChannelProgressPresentation } from "#channel/progress-renderer.js";
import { deserializeContext } from "#context/serialize.js";
import type { ProgressSnapshotV1 } from "#protocol/progress.js";
import { createLogger, logError } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.session-progress-renderer");

export interface SessionProgressRenderState {
  readonly rendererStates: Readonly<Record<string, unknown>>;
}

/** Runs channel-owned progress effects from collector-owned immutable context. */
export async function renderSessionProgressStep(input: {
  readonly rendererStates: Readonly<Record<string, unknown>>;
  readonly serializedContext: Record<string, unknown>;
  readonly snapshot: ProgressSnapshotV1;
}): Promise<SessionProgressRenderState> {
  "use step";

  const { adapter, destination, presentation } = await resolveProgressPresentation(
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
        logError(log, "progress renderer failed", error, {
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
export async function disposeSessionProgressStep(input: {
  readonly rendererStates: Readonly<Record<string, unknown>>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const { adapter, destination, presentation } = await resolveProgressPresentation(
    input.serializedContext,
  );
  for (const renderer of presentation.renderers) {
    if (renderer.dispose === undefined) continue;
    try {
      await renderer.dispose({ destination, state: input.rendererStates[renderer.id] });
    } catch (error) {
      logError(log, "progress renderer disposal failed", error, {
        adapterKind: adapter.kind,
        rendererId: renderer.id,
      });
    }
  }
}

async function resolveProgressPresentation(serializedContext: Record<string, unknown>) {
  const ctx = await deserializeContext(serializedContext);
  const adapter = ctx.require(ChannelKey);
  const presentation = getChannelProgressPresentation(adapter);
  if (presentation === undefined) throw new Error("Channel has no progress presentation.");
  return {
    adapter,
    destination: presentation.destination(adapter.state),
    presentation,
  };
}
