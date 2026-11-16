import { beforeEach, describe, expect, it, vi } from "vitest";

import humanHandoff from "../../agent/tools/human_handoff";

const mocks = vi.hoisted(() => ({
  issueBrowserHandoffUrl: vi.fn(),
  saveBrowserRuntime: vi.fn(),
  getTaskState: vi.fn(),
}));

vi.mock("../../server/browser/handoff.js", () => ({
  issueBrowserHandoffUrl: mocks.issueBrowserHandoffUrl,
}));
vi.mock("../../agent/lib/browser-runtime", () => ({
  saveBrowserRuntime: mocks.saveBrowserRuntime,
}));
vi.mock("../../agent/lib/task-state", () => ({
  taskState: { get: mocks.getTaskState },
}));

const ctx = () => ({
  session: { id: "wrun_01M1MQKPMZV87YPFE30E58NSVF" },
  abortSignal: new AbortController().signal,
});

describe("human_handoff tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskState.mockReturnValue({
      browser: {
        sessionId: "6f906e47-e7bd-4d42-bd1b-e36c49c72e44",
      },
    });
    mocks.issueBrowserHandoffUrl.mockReturnValue("https://bell.example/handoff/opaque-token");
  });

  it("issues a scoped handoff for the current Eve and browser sessions", async () => {
    const result = await humanHandoff.execute({ reason: "otp" }, ctx() as never);

    expect(mocks.saveBrowserRuntime).toHaveBeenCalledWith("wrun_01M1MQKPMZV87YPFE30E58NSVF");
    expect(mocks.issueBrowserHandoffUrl).toHaveBeenCalledWith(
      {
        eveSessionId: "wrun_01M1MQKPMZV87YPFE30E58NSVF",
        browserSessionId: "6f906e47-e7bd-4d42-bd1b-e36c49c72e44",
      },
      { ttlMs: 600_000 },
    );
    expect(result).toMatchObject({
      status: "waiting_for_user",
      reason: "otp",
      handoffUrl: "https://bell.example/handoff/opaque-token",
      expiresInSeconds: 600,
    });
    const action = (result as { action: string }).action;
    expect(action).toContain("Print the complete raw handoffUrl on its own line");
    expect(action).toContain("Never use Markdown link syntax");
    expect(humanHandoff.description).toContain(
      "print the complete raw handoff URL on its own line",
    );
  });

  it("requires a running hosted browser", async () => {
    mocks.getTaskState.mockReturnValue({ browser: {} });

    await expect(humanHandoff.execute({ reason: "login" }, ctx() as never)).rejects.toThrow(
      "Open the required page with a browser tool first",
    );
    expect(mocks.issueBrowserHandoffUrl).not.toHaveBeenCalled();
  });

  it("stops before issuing a link when the turn is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      humanHandoff.execute({ reason: "captcha" }, {
        session: { id: "wrun_01M1MQKPMZV87YPFE30E58NSVF" },
        abortSignal: controller.signal,
      } as never),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.saveBrowserRuntime).not.toHaveBeenCalled();
    expect(mocks.issueBrowserHandoffUrl).not.toHaveBeenCalled();
  });
});
