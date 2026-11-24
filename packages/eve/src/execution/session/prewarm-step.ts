import { processApp } from "#runtime/app.js";
import { startSessionPrewarmers } from "#context/prewarm.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession, projectToDurableSession } from "#execution/session.js";
import type { SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { createLogger } from "#internal/logging.js";
import type { SandboxRunning } from "#sandbox/state.js";

const log = createLogger("execution.session.prewarm");

interface SessionPrewarmInput {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export async function prewarmSessionStep(
  input: SessionPrewarmInput,
): Promise<SessionStateTransition & { readonly sandboxRunning?: SandboxRunning }> {
  "use step";
  return await withSessionStateDelta(processApp().hosts, input, prewarmSession);
}

async function prewarmSession(input: SessionPrewarmInput): Promise<{
  readonly sandboxRunning?: SandboxRunning;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
}> {
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const session = hydrateDurableSession(readDurableSession(input.sessionState));
    const scoped = await withContextScope(ctx, session, async (current) => {
      startSessionPrewarmers(ctx, "session");
      return { result: undefined, session: current };
    });
    return {
      sandboxRunning: scoped.session.sandboxState?.running,
      serializedContext: serializeContext(ctx),
      sessionState: replaceDurableSessionSnapshot({
        session: projectToDurableSession(scoped.session),
        state: input.sessionState,
      }),
    };
  } catch (error) {
    log.warn("session prewarm failed; the first turn does this work instead", {
      error,
      sessionId: input.sessionState.sessionId,
    });
    return {};
  }
}
