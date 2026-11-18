import { SandboxKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { EnsuredSandboxAccess, SandboxCheck } from "#execution/sandbox/ensure.js";
import { withinTimeout } from "#execution/sandbox/within-timeout.js";
import { hydrateDurableSession } from "#execution/session.js";
import type { SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { createLogger } from "#internal/logging.js";
import { clearSandboxRunning, keptRunningUntil, type SandboxState } from "#sandbox/state.js";

const log = createLogger("execution.session.sandbox-check");

const SANDBOX_STOP_TIMEOUT_MS = 120_000;

const SANDBOX_CHECK_TIMEOUT_MS = 30_000;

interface SandboxCheckInput {
  readonly now: number;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly stop: boolean;
}

export async function checkSessionSandboxStep(
  input: SandboxCheckInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, checkSessionSandbox);
}

async function runCheck(input: SandboxCheckInput, durable: DurableSession): Promise<SandboxCheck> {
  const ctx = await deserializeContext(input.serializedContext);
  const { result } = await withContextScope(
    ctx,
    hydrateDurableSession(durable),
    async (session) => {
      const access = ctx.get(SandboxKey) as EnsuredSandboxAccess | undefined;
      const check: SandboxCheck =
        access === undefined
          ? { kind: "not-running" }
          : await withinTimeout(
              input.stop ? SANDBOX_STOP_TIMEOUT_MS : SANDBOX_CHECK_TIMEOUT_MS,
              input.stop
                ? "The sandbox provider did not finish checking or stopping the session's sandbox within 120 seconds."
                : "The sandbox provider did not finish checking the session's sandbox within 30 seconds.",
              (signal) => access.checkRunning({ now: input.now, signal, stop: input.stop }),
            );
      return { result: check, session };
    },
  );
  return result;
}

async function checkSessionSandbox(
  input: SandboxCheckInput,
): Promise<{ readonly sessionState: DurableSessionState }> {
  const durable = readDurableSession(input.sessionState);
  const recorded = durable.sandboxState?.running;
  const unchanged = { sessionState: input.sessionState };
  const write = (sandboxState: SandboxState | undefined) => ({
    sessionState: replaceDurableSessionSnapshot({
      session: { ...durable, sandboxState },
      state: input.sessionState,
    }),
  });
  let failed: { readonly error: unknown; readonly step: "check" | "stop" };
  try {
    const check = await runCheck(input, durable);
    if (check.kind === "not-running") return write(clearSandboxRunning(durable.sandboxState));
    if (check.kind === "stop-failed") failed = { error: check.error, step: "stop" };
    else {
      if (durable.sandboxState === undefined || recorded === undefined) return unchanged;
      const { idleTimeoutMs } = recorded;
      const { keepRunning } = check;
      return write({
        session: durable.sandboxState.session,
        running: keepRunning.length === 0 ? { idleTimeoutMs } : { idleTimeoutMs, keepRunning },
      });
    }
  } catch (error) {
    failed = { error, step: "check" };
  }
  const kept = keptRunningUntil(recorded, input.now) !== undefined;
  const triesAgain = !input.stop || kept;
  log.warn(
    !triesAgain
      ? "failed to stop an idle session sandbox; the provider's own timeout still applies"
      : !kept
        ? "failed to check a session sandbox during a turn; nothing keeps it running, and eve stops it once the session has been idle for idleTimeoutMs"
        : failed.step === "stop"
          ? "failed to stop a session sandbox that nothing keeps running; eve tries again at the next check"
          : "failed to check a session sandbox that keepRunning() keeps running; eve checks again",
    { error: failed.error, sessionId: input.sessionState.sessionId },
  );
  return triesAgain ? unchanged : write(clearSandboxRunning(durable.sandboxState));
}
