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
