import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { issueInboxHandle, readInboxHandle } from "#execution/session-inbox/handle.js";
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

beforeEach(() =>
  vi.stubEnv("EVE_INBOX_HANDLE_SECRET", "test-inbox-key-with-at-least-32-characters"),
);
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("reusing a session inbox handle", () => {
  it("uses the resolved inbox and refreshes it only after a definite stale-owner refusal", async () => {
    runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
    runtime.resumeHook
      .mockRejectedValueOnce(new HookNotFoundError(hook.token))
      .mockResolvedValueOnce({ ...hook, runId: "wrun_successor", hookId: "hook_successor" });
    const result = await resumeRunnableHook(hook.token, payload, issueInboxHandle(hook));
    expect(runtime.resumeHook.mock.calls.map(([target]) => target)).toEqual([hook, hook.token]);
    expect(result.runId).toBe("wrun_successor");
  });

  it("does not redeliver when the resolved write has an uncertain outcome", async () => {
    runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
    const timeout = new Error("The write response timed out");
    runtime.resumeHook.mockRejectedValue(timeout);
    await expect(resumeRunnableHook(hook.token, payload, issueInboxHandle(hook))).rejects.toBe(
      timeout,
    );
    expect(runtime.resumeHook).toHaveBeenCalledTimes(1);
  });

  it("rejects modified routing and encryption fields before a delivery", async () => {
    const handle = issueInboxHandle(hook)!;
    const [version, body, mac] = handle.split(".");
    const descriptor = JSON.parse(Buffer.from(body!, "base64url").toString());
    descriptor.runId = "wrun_another_session";
    descriptor.resumeContext.encryptionPublicKey = "attacker-key";
    const tampered = `${version}.${Buffer.from(JSON.stringify(descriptor)).toString("base64url")}.${mac}`;
    expect(readInboxHandle(tampered)).toBeUndefined();
    runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
    runtime.resumeHook.mockResolvedValue(hook);
    await resumeRunnableHook(hook.token, payload, tampered);
    expect(runtime.resumeHook).toHaveBeenCalledExactlyOnceWith(hook.token, payload);
    vi.stubEnv("EVE_INBOX_HANDLE_SECRET", "a-different-secret-with-at-least-32-characters");
    expect(readInboxHandle(handle)).toBeUndefined();
    vi.stubEnv("EVE_INBOX_HANDLE_SECRET", "");
    expect(issueInboxHandle(hook)).toBeUndefined();
  });

  it.each(["malformed", JSON.stringify(hook)])(
    "resolves the token normally for an unsigned hint: %s",
    async (hint) => {
      runtime.getWorld.mockResolvedValue({ capabilities: { deploymentAffinity: true } });
      runtime.resumeHook.mockResolvedValue(hook);
      await resumeRunnableHook(hook.token, payload, hint);
      expect(runtime.resumeHook).toHaveBeenCalledExactlyOnceWith(hook.token, payload);
    },
  );
});
