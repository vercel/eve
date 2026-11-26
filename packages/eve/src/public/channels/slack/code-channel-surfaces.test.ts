import { describe, expect, it, vi } from "vitest";

import {
  SLACK_DIFF_VIEW_MAX_BYTES,
  setCodeChannelContextBar,
  setCodeChannelDiffView,
} from "#public/channels/slack/code-channel-surfaces.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

function channel(codeChannel = true, responses: Record<string, unknown>[] = []) {
  const request = vi.fn(async (_operation: string, _body: unknown) => {
    return (responses.shift() ?? { ok: true, view_id: "V1" }) as never;
  });
  return {
    request,
    channel: {
      slack: { channelId: "C1", codeChannel, request } as never,
      state: { channelId: "C1", codeChannel, teamId: null, threadTs: null } as SlackChannelState,
    },
  };
}

const items = [{ key: "repo", label: "acme/app", icon: "folder" }];
const fileDiff = (name: string, body: string) =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+${body}\n`;

describe("setCodeChannelContextBar", () => {
  it("does nothing outside a code channel", async () => {
    const { channel: ctx, request } = channel(false);
    await expect(setCodeChannelContextBar(ctx, items)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("sets the items and skips an unchanged update", async () => {
    const { channel: ctx, request } = channel();
    await expect(setCodeChannelContextBar(ctx, items)).resolves.toBe(true);
    await expect(setCodeChannelContextBar(ctx, items)).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("agents.conversations.setProperties", {
      channel_id: "C1",
      code_channel: { context_bar_items: items },
    });
  });

  it("retries after Slack refuses", async () => {
    const { channel: ctx, request } = channel(true, [{ ok: false, error: "ratelimited" }]);
    await expect(setCodeChannelContextBar(ctx, items)).resolves.toBe(false);
    await expect(setCodeChannelContextBar(ctx, items)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("setCodeChannelDiffView", () => {
  it("sets the view once per diff and takes it down when the diff is empty", async () => {
    const { channel: ctx, request } = channel();
    const view = { content: fileDiff("a.ts", "x"), baseBranch: "main", headBranch: "fix" };
    await expect(setCodeChannelDiffView(ctx, view)).resolves.toBe(true);
    await expect(setCodeChannelDiffView(ctx, view)).resolves.toBe(true);
    await expect(setCodeChannelDiffView(ctx, { content: "" })).resolves.toBe(true);
    await expect(setCodeChannelDiffView(ctx, null)).resolves.toBe(true);
    expect(request.mock.calls).toEqual([
      [
        "agents.conversations.setView",
        {
          channel_id: "C1",
          type: "diff",
          content: view.content,
          base_branch: "main",
          head_branch: "fix",
        },
      ],
      ["agents.conversations.removeView", { channel_id: "C1", view_id: "V1" }],
    ]);
    expect(ctx.state.codeChannelSurfaces).toEqual({});
  });

  it("forgets a view Slack already removed", async () => {
    const { channel: ctx } = channel(true, [
      { ok: true, view_id: "V1" },
      { ok: false, error: "view_not_found" },
    ]);
    await setCodeChannelDiffView(ctx, { content: fileDiff("a.ts", "x") });
    await expect(setCodeChannelDiffView(ctx, null)).resolves.toBe(true);
    expect(ctx.state.codeChannelSurfaces).toEqual({});
  });

  it("cuts a diff over Slack's limit at the last whole file", async () => {
    const { channel: ctx, request } = channel();
    const first = fileDiff("a.ts", "x");
    const content = first + fileDiff("b.ts", "y".repeat(SLACK_DIFF_VIEW_MAX_BYTES));
    await setCodeChannelDiffView(ctx, { content });
    expect(request).toHaveBeenCalledWith(
      "agents.conversations.setView",
      expect.objectContaining({ content: first }),
    );
  });

  it("leaves the view up when the first file alone is over the limit", async () => {
    const { channel: ctx, request } = channel();
    const content = fileDiff("a.ts", "y".repeat(SLACK_DIFF_VIEW_MAX_BYTES));
    await expect(setCodeChannelDiffView(ctx, { content })).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
