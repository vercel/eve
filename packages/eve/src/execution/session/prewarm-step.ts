import { startSessionPrewarmers } from "#context/prewarm.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession, projectToDurableSession } from "#execution/session.js";
import type { SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
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

async function prewarmSession(input: SessionPrewarmInput): Promise<{
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
}> {
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
    const session = hydrateDurableSession({
      durable: readDurableSession(input.sessionState),
      turnAgent: effectiveAgent.turnAgent,
    });
    // The providers' commit waits for the work the prewarmers started.
    const scoped = await withContextScope(ctx, session, async (current) => {
      startSessionPrewarmers(ctx, "session");
      return { result: undefined, session: current };
    });
    // The selector may update `defineState()` handles, which live in the context.
    return {
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
