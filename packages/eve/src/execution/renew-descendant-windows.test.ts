import { beforeEach, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import { renewDescendantWindows } from "#execution/renew-descendant-windows.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";

const mocks = vi.hoisted(() => ({ getRun: vi.fn(), resumeHook: vi.fn() }));

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  getRun: mocks.getRun,
  resumeHook: mocks.resumeHook,
}));

const session = registerWorkflowToolRun({ state: {} } as unknown as DurableSession, {
  address: { hookToken: "pages-control", runId: "pages-run" },
  callId: "call-1",
  origin: { stepIndex: 0, turnId: "turn-1" },
  toolName: "read_pages",
});

beforeEach(() => {
  vi.resetAllMocks();
});

it("renews a blocking run that registers its control hook after the renewal", async () => {
  // The run started before the approval but hasn't reached its first suspension yet.
  mocks.resumeHook
    .mockRejectedValueOnce(new HookNotFoundError("pages-control"))
    .mockRejectedValueOnce(new HookNotFoundError("pages-control"))
    .mockResolvedValueOnce({ runId: "pages-run" });
  mocks.getRun.mockReturnValue({ status: Promise.resolve("running") });

  await renewDescendantWindows(session, "R");

  expect(mocks.resumeHook).toHaveBeenCalledTimes(3);
  expect(mocks.resumeHook).toHaveBeenLastCalledWith("pages-control", {
    kind: "renew-window",
    renewalId: "R",
  });
});

it("skips a blocking run that already ended", async () => {
  mocks.resumeHook.mockRejectedValue(new HookNotFoundError("pages-control"));
  mocks.getRun.mockReturnValue({ status: Promise.resolve("completed") });

  await renewDescendantWindows(session, "R");

  expect(mocks.resumeHook).toHaveBeenCalledOnce();
});
