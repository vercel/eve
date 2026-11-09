import { afterEach, describe, expect, it, vi } from "vitest";
import { prewarmWorkflowSession } from "#execution/session-prewarm.js";
import { getHookByToken, getWorld } from "#internal/workflow/runtime.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: vi.fn(), getHookByToken: vi.fn() }));
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));
afterEach(() => vi.resetAllMocks());
describe("session prewarm ingress", () => {
  it.each([
    ["dpl_b", "1", "ready"],
    ["dpl_a", undefined, "unsupported"],
    ["dpl_a", "1", "accepted"],
  ] as const)(
    "handles owner deployment %s and support %s as %s",
    async (deploymentId, support, status) => {
      const get = vi.fn().mockResolvedValue({
        status: "running",
        deploymentId,
        attributes: { "$eve.prewarm": support },
      });
      vi.mocked(getWorld).mockResolvedValue({
        capabilities: { deploymentAffinity: true },
        runs: { get },
      } as never);
      vi.mocked(getHookByToken).mockResolvedValue({ runId: "wrun_owner" } as never);
      await expect(prewarmWorkflowSession("wrun_session", "dpl_b")).resolves.toEqual({ status });
      if (status === "accepted")
        expect(resumeSessionInbox).toHaveBeenCalledWith(
          { sessionId: "wrun_session" },
          {
            kind: "session-prewarm",
            targetDeploymentId: "dpl_b",
            expectedOwnerRunId: "wrun_owner",
          },
        );
      else expect(resumeSessionInbox).not.toHaveBeenCalled();
    },
  );
  it("propagates failed durable acceptance without reporting completion", async () => {
    vi.mocked(getWorld).mockResolvedValue({
      capabilities: { deploymentAffinity: true },
      runs: {
        get: vi.fn().mockResolvedValue({
          status: "running",
          deploymentId: "dpl_a",
          attributes: { "$eve.prewarm": "1" },
        }),
      },
    } as never);
    vi.mocked(getHookByToken).mockResolvedValue({ runId: "wrun_owner" } as never);
    vi.mocked(resumeSessionInbox).mockRejectedValue(new Error("acceptance failed"));
    await expect(prewarmWorkflowSession("wrun_session", "dpl_b")).rejects.toThrow(
      "acceptance failed",
    );
  });
});
