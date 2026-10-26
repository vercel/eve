import { afterEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";

const runtime = vi.hoisted(() => ({ resumeHook: vi.fn(), getWorld: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", async (importActual) => ({
  ...(await importActual<typeof import("#internal/workflow/runtime.js")>()),
  ...runtime,
}));

const hook = {
  runId: "wrun_original",
  hookId: "hook_inbox",
  token: "inbox-token",
  ownerId: "team_test",
  projectId: "prj_test",
  environment: "preview",
  createdAt: new Date("2026-10-26T00:00:00Z"),
  resumeContext: {
    deploymentId: "dpl_test",
    workflowName: "session",
    encryptionPublicKey: "public-key",
  },
};
const payload = { kind: "message", message: "How do preview deployments work?" };

afterEach(() => vi.resetAllMocks());

describe("reusing a session inbox handle", () => {
  it("uses the resolved inbox and refreshes it only after a definite stale-owner refusal", async () => {
    runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
    runtime.resumeHook
      .mockRejectedValueOnce(new HookNotFoundError(hook.token))
      .mockResolvedValueOnce({ ...hook, runId: "wrun_successor", hookId: "hook_successor" });
    const result = await resumeRunnableHook(hook.token, payload, JSON.stringify(hook));
    expect(runtime.resumeHook.mock.calls.map(([target]) => target)).toEqual([hook, hook.token]);
    expect(result.runId).toBe("wrun_successor");
  });

  it("does not redeliver when the resolved write has an uncertain outcome", async () => {
    runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
    const timeout = new Error("The write response timed out");
    runtime.resumeHook.mockRejectedValue(timeout);
    await expect(resumeRunnableHook(hook.token, payload, JSON.stringify(hook))).rejects.toBe(
      timeout,
    );
    expect(runtime.resumeHook).toHaveBeenCalledTimes(1);
  });

  it.each([
    "malformed",
    JSON.stringify({ ...hook, token: "another-inbox" }),
    JSON.stringify({
      ...hook,
      resumeContext: { deploymentId: "dpl_test", workflowName: "session" },
    }),
  ])("resolves the token normally for an unusable hint: %s", async (hint) => {
    runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
    runtime.resumeHook.mockResolvedValue(hook);
    await resumeRunnableHook(hook.token, payload, hint);
    expect(runtime.resumeHook).toHaveBeenCalledExactlyOnceWith(hook.token, payload);
  });
});
