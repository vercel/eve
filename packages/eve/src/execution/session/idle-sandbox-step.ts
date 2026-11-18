import { SandboxKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { EnsuredSandboxAccess } from "#execution/sandbox/ensure.js";
import { hydrateDurableSession } from "#execution/session.js";
import type { SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { createLogger } from "#internal/logging.js";
import { clearSandboxRunning } from "#sandbox/state.js";

const log = createLogger("execution.session.idle-sandbox");

const IDLE_STOP_TIMEOUT_MS = 120_000;

async function withinIdleStopTimeout<Result>(
  stop: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `The sandbox provider did not stop the idle sandbox within ${IDLE_STOP_TIMEOUT_MS / 1000} seconds.`,
      );
      controller.abort(error);
      reject(error);
    }, IDLE_STOP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([stop(controller.signal), timedOut]);
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
): Promise<SessionStateTransition & { readonly inUse?: boolean }> {
  "use step";
  return await withSessionStateDelta(input, stopIdleSessionSandbox);
}

async function stopIdleSessionSandbox(
  input: IdleSandboxInput,
): Promise<{ readonly inUse?: boolean; readonly sessionState: DurableSessionState }> {
  const durable = readDurableSession(input.sessionState);
  let inUse = false;
  try {
    const ctx = await deserializeContext(input.serializedContext);
    await withContextScope(ctx, hydrateDurableSession(durable), async (session) => {
      const access = ctx.get(SandboxKey) as EnsuredSandboxAccess | undefined;
      if (access !== undefined)
        ({ inUse } = await withinIdleStopTimeout((signal) => access.stopIdle({ signal })));
      return { result: undefined, session };
    });
  } catch (error) {
    inUse = (durable.sandboxState?.running?.backgroundUntil ?? 0) > Date.now();
    log.warn(
      inUse
        ? "failed to check an idle session sandbox that a background command may be using; eve checks again"
        : "failed to stop an idle session sandbox; the provider's own timeout still applies",
      { error, sessionId: input.sessionState.sessionId },
    );
  }
  if (inUse) return { inUse, sessionState: input.sessionState };
  return {
    sessionState: replaceDurableSessionSnapshot({
      session: { ...durable, sandboxState: clearSandboxRunning(durable.sandboxState) },
      state: input.sessionState,
    }),
  };
}
