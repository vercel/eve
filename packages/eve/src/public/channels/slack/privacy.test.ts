import { describe, expect, it, vi } from "vitest";

import {
  isPrivateSlackConversation,
  readSlackConversationPrivacy,
} from "#public/channels/slack/privacy.js";

describe("Slack conversation privacy", () => {
  it("reads explicit conversation types without an API lookup", async () => {
    const request = vi.fn();

    expect(readSlackConversationPrivacy({ channel_type: "channel" })).toBe("public");
    expect(readSlackConversationPrivacy({ channel_type: "im" })).toBe("private");
    expect(readSlackConversationPrivacy({ channel_type: "mpim" })).toBe("private");
    expect(readSlackConversationPrivacy({ channel_type: "group" })).toBe("private");
    expect(readSlackConversationPrivacy({})).toBe("unknown");
    await expect(
      isPrivateSlackConversation({
        channelId: "C01",
        raw: { channel_type: "channel" },
        request,
      }),
    ).resolves.toBe(false);
    await expect(
      isPrivateSlackConversation({ channelId: "D01", raw: { channel_type: "im" }, request }),
    ).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { isPrivate: false, expected: false },
    { isPrivate: true, expected: true },
  ])(
    "resolves events without channel_type through conversations.info when is_private is $isPrivate",
    async ({ isPrivate, expected }) => {
      const request = vi.fn().mockResolvedValue({
        ok: true,
        channel: { is_private: isPrivate },
      });

      await expect(
        isPrivateSlackConversation({ channelId: "C01", raw: {}, request }),
      ).resolves.toBe(expected);
      expect(request).toHaveBeenCalledWith("conversations.info", { channel: "C01" });
    },
  );

  it.each([
    { response: { ok: true, channel: { is_private: true } }, label: "private channel" },
    { response: { ok: true, channel: { is_im: true } }, label: "DM" },
    { response: { ok: true, channel: { is_mpim: true } }, label: "group DM" },
    { response: { ok: true, channel: {} }, label: "ambiguous response" },
    { response: { ok: false, error: "missing_scope" }, label: "failed response" },
  ])("treats a $label lookup as private", async ({ response }) => {
    await expect(
      isPrivateSlackConversation({
        channelId: "C01",
        raw: {},
        request: vi.fn().mockResolvedValue(response),
      }),
    ).resolves.toBe(true);
  });

  it("fails closed when conversations.info throws", async () => {
    await expect(
      isPrivateSlackConversation({
        channelId: "C01",
        raw: {},
        request: vi.fn().mockRejectedValue(new Error("missing_scope")),
      }),
    ).resolves.toBe(true);
  });
});
