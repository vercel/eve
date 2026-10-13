import { beforeEach, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";

const mocks = vi.hoisted(() => ({ getRun: vi.fn(), resumeHook: vi.fn() }));

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  getRun: mocks.getRun,
  resumeHook: mocks.resumeHook,
}));

const run = { hookToken: "hold-control", runId: "hold-run" };

beforeEach(() => {
  vi.resetAllMocks();
});

it("interrupts a run that registers its control hook after the turn is steered", async () => {
  // Alice steers the turn just as it starts the run, before the run's first suspension.
  mocks.resumeHook
    .mockRejectedValueOnce(new HookNotFoundError("hold-control"))
    .mockRejectedValueOnce(new HookNotFoundError("hold-control"))
    .mockResolvedValueOnce({ runId: "hold-run" });
  mocks.getRun.mockReturnValue({ status: Promise.resolve("running") });

  await interruptWorkflowToolRun(run);

  expect(mocks.resumeHook).toHaveBeenCalledTimes(3);
  expect(mocks.resumeHook).toHaveBeenLastCalledWith("hold-control", { kind: "interrupt" });
});

it("leaves a run that already ended alone", async () => {
  mocks.resumeHook.mockRejectedValue(new HookNotFoundError("hold-control"));
  mocks.getRun.mockReturnValue({ status: Promise.resolve("completed") });

  await interruptWorkflowToolRun(run);

  expect(mocks.resumeHook).toHaveBeenCalledOnce();
});

it("fails instead of dropping the interrupt when the run registers its hook after the deadline", async () => {
  vi.useFakeTimers();
  try {
    // Bob's deploy run is slow to start and registers its control hook only after 40 seconds.
    const registeredAt = Date.now() + 40_000;
    mocks.resumeHook.mockImplementation(async () => {
      if (Date.now() < registeredAt) throw new HookNotFoundError("hold-control");
      return { runId: "hold-run" };
    });
    mocks.getRun.mockReturnValue({ status: Promise.resolve("running") });

    const attempt = expect(interruptWorkflowToolRun(run)).rejects.toThrow(
      'Workflow tool run "hold-run" did not start taking commands within 30 seconds',
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await attempt;

    // The runtime retries the failed step, which delivers the interrupt once the hook exists.
    await vi.advanceTimersByTimeAsync(10_000);
    await interruptWorkflowToolRun(run);
    expect(mocks.resumeHook).toHaveBeenLastCalledWith("hold-control", { kind: "interrupt" });
    await expect(mocks.resumeHook.mock.results.at(-1)?.value).resolves.toEqual({
      runId: "hold-run",
    });
  } finally {
    vi.useRealTimers();
  }
});
