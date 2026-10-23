import { startSessionPrewarmers } from "#context/prewarm.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession, projectToDurableSession } from "#execution/session.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { createLogger } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.session.prewarm");

interface SessionPrewarmInput {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Starts the session prewarmers for a session started without a message and
 * records what they prepared, such as the sandbox state, once their work
 * settles. Runs beside the wait for the first message and never fails.
 */
export async function prewarmSessionStep(
  input: SessionPrewarmInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, prewarmSession);
}

async function prewarmSession(
  input: SessionPrewarmInput,
): Promise<{ readonly sessionState?: DurableSessionState }> {
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
    const session = hydrateDurableSession({
      compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
      durable: readDurableSession(input.sessionState),
      turnAgent: effectiveAgent.turnAgent,
    });
    // The providers' commit waits for the work the prewarmers started.
    const scoped = await withContextScope(ctx, session, async (current) => {
      startSessionPrewarmers(ctx, "session");
      return { result: undefined, session: current };
    });
    return {
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
