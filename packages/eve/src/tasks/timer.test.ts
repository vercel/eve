import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sleep } from "#compiled/@workflow/core/index.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { taskTimerWorkflowReference } from "#execution/workflow-runtime.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { readTaskTimer, TASK_TIMER_STATE_KEY } from "#tasks/state.js";
import {
  armTaskTimerStep,
  cancelTaskTimerStep,
  signalTaskDeadlineStep,
} from "#tasks/timer-steps.js";
import { taskTimerWorkflow } from "#tasks/timer.js";

const startMock = vi.fn();
const resumeHookMock = vi.fn();
const getHookMock = vi.fn();
const cancelRunMock = vi.fn();
const getWorldMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ workflowRunId: "owner-run" }),
  sleep: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getHookByToken: (...args: unknown[]) => getHookMock(...args),
  getWorld: (...args: unknown[]) => getWorldMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  start: (...args: unknown[]) => startMock(...args),
}));

const WAKE_AT = "2026-09-24T14:00:00.000Z";
const TOKEN = "eve:session:parent:inbox";

beforeEach(() => {
  getWorldMock.mockResolvedValue({ getDeploymentId: async () => "dpl_current" });
  getHookMock.mockImplementation((...args: unknown[]) => resumeHookMock(...args));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("taskTimerWorkflow", () => {
  it("signals the owner only after its durable sleep settles", async () => {
    let wake: (() => void) | undefined;
    vi.mocked(sleep).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    );
    resumeHookMock.mockResolvedValue({ runId: "owner-run" });

    const timer = taskTimerWorkflow({ ownerRunId: "owner-run", token: TOKEN, wakeAt: WAKE_AT });
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledWith(new Date(WAKE_AT));
    });
    expect(resumeHookMock).not.toHaveBeenCalled();

    wake?.();
    await timer;

    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(`eve:inbox:v1:${TOKEN}`, {
      kind: "task.deadline",
      ownerRunId: "owner-run",
      wakeAt: WAKE_AT,
    });
  });
});

describe("task timer steps", () => {
  it("starts the timer on this deployment, records it, and cancels the one it replaces", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    startMock.mockResolvedValue({ runId: "timer-2" });
    const base = createTestSessionState({ sessionId: "parent" });
    const sessionState = {
      ...base,
      snapshot: {
        session: {
          ...base.snapshot.session,
          state: {
            [TASK_TIMER_STATE_KEY]: {
              ownerRunId: "owner-run",
              runId: "timer-1",
              wakeAt: "2026-09-24T15:00:00.000Z",
            },
          },
        },
      },
    };

    const armed = await armTaskTimerStep({ sessionState, wakeAt: WAKE_AT });

    expect(startMock).toHaveBeenCalledWith(
      taskTimerWorkflowReference,
      [{ ownerRunId: "owner-run", token: TOKEN, wakeAt: WAKE_AT }],
      { deploymentId: "dpl_current" },
    );
    expect(cancelRunMock).toHaveBeenCalledWith(expect.anything(), "timer-1", {
      cancelReason: expect.any(String),
    });
    expect(readTaskTimer(readDurableSession(armed.sessionState).state)).toEqual({
      ownerRunId: "owner-run",
      runId: "timer-2",
      wakeAt: WAKE_AT,
    });
  });

  it("cancels the armed timer and clears it once nothing is due", async () => {
    const base = createTestSessionState({ sessionId: "parent" });
    const sessionState = {
      ...base,
      snapshot: {
        session: {
          ...base.snapshot.session,
          state: {
            [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner-run", runId: "timer-1", wakeAt: WAKE_AT },
          },
        },
      },
    };

    const cleared = await cancelTaskTimerStep({ sessionState });

    expect(cancelRunMock).toHaveBeenCalledWith(expect.anything(), "timer-1", {
      cancelReason: expect.any(String),
    });
    expect(readTaskTimer(readDurableSession(cleared.sessionState).state)).toBeUndefined();
  });

  it("fails the signal step while the session is still mid-handoff, so Workflow retries it", async () => {
    vi.useFakeTimers();
    try {
      const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
      resumeHookMock.mockRejectedValue(new HookNotFoundError(TOKEN));
      // The releasing owner's marker outlasts the inbox's own retry window.
      getHookMock.mockImplementation(async (token: string) => {
        if (token.startsWith("eve:inbox:handoff:")) return { runId: "old-owner" };
        throw new HookNotFoundError(token);
      });

      const signal = signalTaskDeadlineStep({
        ownerRunId: "owner-run",
        token: TOKEN,
        wakeAt: WAKE_AT,
      });
      const settled = expect(signal).rejects.toSatisfy((error) => HookNotFoundError.is(error));
      await vi.advanceTimersByTimeAsync(6_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a signal after the owning session is gone", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    resumeHookMock.mockRejectedValue(new HookNotFoundError(TOKEN));

    await expect(
      signalTaskDeadlineStep({ ownerRunId: "owner-run", token: TOKEN, wakeAt: WAKE_AT }),
    ).resolves.toBeUndefined();
  });

  it("propagates an unexpected signal failure so Workflow retries it", async () => {
    const failure = new Error("resume failed");
    resumeHookMock.mockRejectedValue(failure);

    await expect(
      signalTaskDeadlineStep({ ownerRunId: "owner-run", token: TOKEN, wakeAt: WAKE_AT }),
    ).rejects.toBe(failure);
  });
});
