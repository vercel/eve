import { beforeEach, expect, it, vi } from "vitest";

import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { HookNotFoundError, RetryableError } from "#compiled/@workflow/errors/index.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import { interruptWorkflowToolRun } from "./interrupt.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({ getStepMetadata: vi.fn() }));
vi.mock("#internal/logging.js", () => ({ createLogger: vi.fn(() => ({})), logError: vi.fn() }));

const address = { hookToken: "control", runId: "run" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStepMetadata).mockReturnValue({ attempt: 1 } as ReturnType<typeof getStepMetadata>);
});

it("delivers an interrupt to a registered hook", async () => {
  await interruptWorkflowToolRun(address);
  expect(resumeHook).toHaveBeenCalledWith("control", { kind: "interrupt" });
  expect(getRun).not.toHaveBeenCalled();
});

it.each(["pending", "running"])(
  "does not discard an interrupt while the run is %s",
  async (status) => {
    const error = new HookNotFoundError("control");
    vi.mocked(resumeHook).mockRejectedValue(error);
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve(status) } as ReturnType<
      typeof getRun
    >);
    await expect(interruptWorkflowToolRun(address)).rejects.toBeInstanceOf(RetryableError);
  },
);

it.each(["completed", "failed", "cancelled"])(
  "ignores a missing hook once the run is %s",
  async (status) => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("control"));
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve(status) } as ReturnType<
      typeof getRun
    >);
    await expect(interruptWorkflowToolRun(address)).resolves.toBeUndefined();
  },
);

it("does not hide unrelated delivery failures", async () => {
  const error = new Error("transport unavailable");
  vi.mocked(resumeHook).mockRejectedValue(error);
  await expect(interruptWorkflowToolRun(address)).rejects.toBe(error);
  expect(getRun).not.toHaveBeenCalled();
});

it.each(["pending", "running"])(
  "exhausted startup retries do not fail the calling turn (%s)",
  async (status) => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("control"));
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve(status) } as ReturnType<
      typeof getRun
    >);
    const maxRetries = (
      interruptWorkflowToolRun as typeof interruptWorkflowToolRun & { maxRetries: number }
    ).maxRetries;
    expect(maxRetries).toBe(60);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      vi.mocked(getStepMetadata).mockReturnValue({ attempt } as ReturnType<typeof getStepMetadata>);
      await expect(interruptWorkflowToolRun(address)).rejects.toBeInstanceOf(RetryableError);
    }
    vi.mocked(getStepMetadata).mockReturnValue({ attempt: maxRetries + 1 } as ReturnType<
      typeof getStepMetadata
    >);
    await expect(interruptWorkflowToolRun(address)).resolves.toBeUndefined();
  },
);

it.each(["delivery", "status"])(
  "does not fail the calling turn on exhausted %s errors",
  async (kind) => {
    vi.mocked(getStepMetadata).mockReturnValue({ attempt: 61 } as ReturnType<
      typeof getStepMetadata
    >);
    vi.mocked(resumeHook).mockRejectedValue(
      kind === "delivery" ? new Error("transport unavailable") : new HookNotFoundError("control"),
    );
    vi.mocked(getRun).mockImplementation(() => {
      throw new Error("status unavailable");
    });
    await expect(interruptWorkflowToolRun(address)).resolves.toBeUndefined();
  },
);

it("ignores a missing run", async () => {
  vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("control"));
  vi.mocked(getRun).mockImplementation(() => {
    throw new HookNotFoundError("run");
  });
  await expect(interruptWorkflowToolRun(address)).resolves.toBeUndefined();
});
