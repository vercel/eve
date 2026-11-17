import { SandboxKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { EnsuredSandboxAccess } from "#execution/sandbox/ensure.js";
import { hydrateDurableSession, projectToDurableSession } from "#execution/session.js";
import type { SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { createLogger } from "#internal/logging.js";
import { clearSandboxRunning } from "#sandbox/state.js";

const log = createLogger("execution.session.idle-sandbox");

const IDLE_STOP_TIMEOUT_MS = 120_000;

async function withinIdleStopTimeout(stop: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The sandbox provider did not stop the idle sandbox within ${IDLE_STOP_TIMEOUT_MS / 1000} seconds.`,
          ),
        ),
      IDLE_STOP_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([stop, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

interface IdleSandboxInput {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export async function stopIdleSessionSandboxStep(
  input: IdleSandboxInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, stopIdleSessionSandbox);
}

async function stopIdleSessionSandbox(
  input: IdleSandboxInput,
): Promise<{ readonly sessionState: DurableSessionState }> {
  const durable = readDurableSession(input.sessionState);
  const report = (error: unknown) => {
    log.warn("failed to stop an idle session sandbox; the provider's own timeout still applies", {
      error,
      sessionId: input.sessionState.sessionId,
    });
  };
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const scoped = await withContextScope(ctx, hydrateDurableSession(durable), async (session) => {
      const access = ctx.get(SandboxKey) as EnsuredSandboxAccess | undefined;
      if (access !== undefined) await withinIdleStopTimeout(access.stopIdle()).catch(report);
      return { result: undefined, session };
    });
    return {
      sessionState: replaceDurableSessionSnapshot({
        session: {
          ...projectToDurableSession(scoped.session),
          sandboxState: clearSandboxRunning(scoped.session.sandboxState),
        },
        state: input.sessionState,
      }),
    };
  } catch (error) {
    report(error);
    return {
      sessionState: replaceDurableSessionSnapshot({
        session: { ...durable, sandboxState: clearSandboxRunning(durable.sandboxState) },
        state: input.sessionState,
      }),
    };
  }
}
