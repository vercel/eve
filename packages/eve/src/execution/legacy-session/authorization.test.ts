import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHost } from "#execution/hosts.js";
import { resumeAuthorizationCallback, handleExpiredLegacyAuthorization } from "./authorization.js";
const mocks = vi.hoisted(() => ({ resume: vi.fn() }));
// Owner classification has its own tests; every owner here is runnable.
vi.mock("#execution/session-inbox/owner.js", () => ({
  resumeRunnableHook: (token: string, payload: unknown) => mocks.resume(token, payload),
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
describe("authorization callbacks", () => {
  it("delivers a callback to the Workflow hook its token names", async () => {
    mocks.resume.mockResolvedValue({ runId: "current" });
    await resumeAuthorizationCallback("eve:inbox:v1:current", payload);
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith("eve:inbox:v1:current", payload);
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
  });
  it("refuses a callback for a hosted session that ended, without asking Workflow", async () => {
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
  });
  it("expires historical URLs that do not identify an authorization attempt", async () => {
    expect((await handleExpiredLegacyAuthorization()).status).toBe(410);
  });
});
