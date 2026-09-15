import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAuthorizationCallback, handleExpiredLegacyAuthorization } from "./authorization.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), resume: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: mocks.resume }));
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
describe("authorization cutover", () => {
  it("delivers current callbacks without historical lookup", async () => {
    await resumeAuthorizationCallback("eve:inbox:v1:current", payload);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith("eve:inbox:v1:current", payload);
  });
  it("rejects historical callbacks after import without queuing them on the new owner", async () => {
    mocks.resolve.mockResolvedValue({ current: true });
    await expect(resumeAuthorizationCallback("old", payload)).rejects.toThrow("interrupted");
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("uses the historical wire envelope before import", async () => {
    mocks.resolve.mockResolvedValue({
      current: false,
      hook: { token: "old", metadata: { sessionInboxWireVersion: 3 } },
    });
    await resumeAuthorizationCallback("old", payload);
    expect(mocks.resume).toHaveBeenCalledWith(
      "old",
      expect.objectContaining({ kind: "deliver", version: 3, payloads: payload.payloads }),
    );
  });
  it("preserves the payload array for an unversioned workflow-tool callback", async () => {
    mocks.resolve.mockResolvedValue({
      current: false,
      hook: { token: "workflow-tool-callback", metadata: undefined },
    });
    await resumeAuthorizationCallback("workflow-tool-callback", payload);
    expect(mocks.resume).toHaveBeenCalledWith(
      "workflow-tool-callback",
      expect.objectContaining({ kind: "deliver", payloads: payload.payloads }),
    );
  });
  it("expires historical URLs that do not identify an authorization attempt", async () => {
    expect((await handleExpiredLegacyAuthorization()).status).toBe(410);
  });
});
