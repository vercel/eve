import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { registerHost } from "#execution/hosts.js";
import { resumeAuthorizationCallback, handleExpiredLegacyAuthorization } from "./authorization.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), resume: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: mocks.resume }));
// Owner classification has its own tests; every owner here is runnable.
vi.mock("#execution/session-inbox/owner.js", () => ({
  resumeRunnableHook: (token: string, payload: unknown) => mocks.resume(token, payload),
}));
vi.mock("./inbox.js", async (original) => ({
  ...(await original<typeof import("./inbox.js")>()),
  resolveLegacyInbox: mocks.resolve,
}));
beforeEach(() => vi.resetAllMocks());
const payload = {
  kind: "authorization-callback" as const,
  payloads: [
    {
      authorizationCallback: {
        attemptId: "attempt",
        connectionName: "weather",
        callback: { method: "GET", params: { code: "test" } },
      },
    },
  ],
};
function missingCurrentInbox(token: string) {
  mocks.resume.mockRejectedValueOnce(new HookNotFoundError(token));
}
describe("authorization cutover", () => {
  it("delivers current callbacks without historical lookup", async () => {
    mocks.resume.mockResolvedValue({ runId: "current" });
    await resumeAuthorizationCallback("eve:inbox:v1:current", payload);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith("eve:inbox:v1:current", payload);
  });
  it("rejects historical callbacks after import without queuing them on the new owner", async () => {
    missingCurrentInbox("old");
    mocks.resolve.mockResolvedValue({ current: true });
    await expect(resumeAuthorizationCallback("old", payload)).rejects.toThrow("interrupted");
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith("old", payload);
  });
  it("uses the historical wire envelope before import", async () => {
    missingCurrentInbox("old");
    mocks.resolve.mockResolvedValue({
      current: false,
      hook: { token: "old", metadata: { sessionInboxWireVersion: 3 } },
    });
    await resumeAuthorizationCallback("old", payload);
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.resume).toHaveBeenLastCalledWith(
      "old",
      expect.objectContaining({ kind: "deliver", version: 3, payloads: payload.payloads }),
    );
  });
  it("delivers to a session a host runs in this process, without asking Workflow", async () => {
    const delivered: unknown[] = [];
    const release = registerHost({
      deliver: async (token, sent) => {
        if (token !== "eve:inbox:v1:hosted") return undefined;
        delivered.push(sent);
        return "delivered";
      },
      runEnded: () => undefined,
      cancelRun: () => undefined,
    });
    try {
      await resumeAuthorizationCallback("eve:inbox:v1:hosted", payload);
    } finally {
      release();
    }
    expect(delivered).toEqual([payload]);
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("refuses a callback for a hosted session that ended, without the legacy lookup", async () => {
    const release = registerHost({
      deliver: async (token) => (token === "eve:inbox:v1:ended" ? "gone" : undefined),
      runEnded: () => undefined,
      cancelRun: () => undefined,
    });
    try {
      // Matched by name, as Workflow's own checks do: the host registry loads its own copy.
      await expect(
        resumeAuthorizationCallback("eve:inbox:v1:ended", payload),
      ).rejects.toMatchObject({
        name: "HookNotFoundError",
        token: "eve:inbox:v1:ended",
      });
    } finally {
      release();
    }
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("expires historical URLs that do not identify an authorization attempt", async () => {
    expect((await handleExpiredLegacyAuthorization()).status).toBe(410);
  });
});
