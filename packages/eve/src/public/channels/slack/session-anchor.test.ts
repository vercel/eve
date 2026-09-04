import { describe, expect, it, vi } from "vitest";
import {
  resolveSlackSessionAnchor,
  slackSessionAnchor,
} from "#public/channels/slack/session-anchor.js";
import type { Session } from "#channel/session.js";

describe("Slack session anchors", () => {
  it("resolves the original alias while the first posted thread is awaiting rekey", async () => {
    const session = { id: "canonical" } as Session;
    const resolveSession = vi.fn().mockResolvedValue(session);
    const request = vi.fn().mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: "100.1",
          app_id: "A1",
          metadata: slackSessionAnchor("C1", "C1:original-placeholder"),
        },
      ],
    });
    await expect(
      resolveSlackSessionAnchor({
        appId: "A1",
        channelId: "C1",
        threadTs: "100.1",
        request,
        resolveSession,
      }),
    ).resolves.toEqual({ session, continuationToken: "C1:original-placeholder" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("conversations.replies", {
      channel: "C1",
      ts: "100.1",
      limit: 1,
      include_all_metadata: true,
    });
    expect(resolveSession).toHaveBeenCalledWith("C1:original-placeholder");
  });
  it.each([
    { app_id: "other-app", ts: "100.1", metadata: slackSessionAnchor("C1", "C1:original") },
    { app_id: "A1", ts: "100.1", metadata: slackSessionAnchor("C2", "C2:original") },
    { app_id: "A1", ts: "100.1", metadata: slackSessionAnchor("C1", "C2:original") },
    { app_id: "A1", ts: "other-root", metadata: slackSessionAnchor("C1", "C1:original") },
  ])("rejects metadata from another app, channel, or root", async (root) => {
    const resolveSession = vi.fn();
    const request = vi.fn().mockResolvedValue({ ok: true, messages: [root] });
    await expect(
      resolveSlackSessionAnchor({
        appId: "A1",
        channelId: "C1",
        threadTs: "100.1",
        request,
        resolveSession,
      }),
    ).resolves.toBeUndefined();
    expect(resolveSession).not.toHaveBeenCalled();
  });
  it("does not create a second session on a failed provider read", async () => {
    await expect(
      resolveSlackSessionAnchor({
        appId: "A1",
        channelId: "C1",
        threadTs: "100.1",
        request: vi.fn().mockResolvedValue({ ok: false }),
        resolveSession: vi.fn(),
      }),
    ).rejects.toThrow("session anchor");
  });
});
