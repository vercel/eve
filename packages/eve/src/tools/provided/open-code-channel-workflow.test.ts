import { describe, expect, it } from "vitest";

import type { WorkflowToolContext } from "#public/tools/index.js";
import { executeOpenCodeChannel } from "#tools/provided/open-code-channel-workflow.js";

function contextFor(metadata: Record<string, unknown> | undefined): WorkflowToolContext {
  return {
    channel: { kind: "channel:slack", metadata, name: "slack" },
    session: { auth: { current: null }, id: "session_thread" },
  } as never;
}

const input = { message: "Start by reproducing it.", name: "Fix the login test" };

describe("executeOpenCodeChannel", () => {
  it.each([
    ["a session without channel metadata", undefined],
    ["a non-Slack conversation", { chatId: "1" }],
  ])("is unavailable for %s", async (_name, metadata) => {
    await expect(executeOpenCodeChannel(input, contextFor(metadata))).resolves.toEqual({
      reason: "This conversation is not a Slack message.",
      status: "unavailable",
    });
  });

  it("is unavailable inside a code channel", async () => {
    const metadata = { channelId: "C1", codeChannel: true, threadTs: null };
    await expect(executeOpenCodeChannel(input, contextFor(metadata))).resolves.toEqual({
      reason: "This conversation is already a code channel.",
      status: "unavailable",
    });
  });
});
