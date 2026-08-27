import { describe, expect, it, vi } from "vitest";

import { waitForSubagentReplyHook } from "#execution/tools/subagent/run.js";
import { waitForCommandHookOwner } from "#execution/workflow-runtime.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  waitForCommandHookOwner: vi.fn(),
}));

describe("subagent relay startup", () => {
  it("does not wait for a disposed child hook when replay attaches to the winning relay", async () => {
    await expect(
      waitForSubagentReplyHook({
        ownsRun: false,
        replyToken: "child-hook",
        runId: "winning-run",
      }),
    ).resolves.toBe(true);
    expect(waitForCommandHookOwner).not.toHaveBeenCalled();
  });

  it("requires a newly started relay to own its child hook", async () => {
    vi.mocked(waitForCommandHookOwner).mockResolvedValue({
      runId: "other-run",
      token: "child-hook",
    } as never);

    await expect(
      waitForSubagentReplyHook({
        ownsRun: true,
        replyToken: "child-hook",
        runId: "new-run",
      }),
    ).resolves.toBe(false);
  });
});
