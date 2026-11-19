import { describe, expect, it } from "vitest";

import { chatSdkInstrumentation } from "#public/channels/chat-sdk/audience.js";
import type { ChatSdkChannelState } from "#public/channels/chat-sdk/chatSdkChannel.js";
import type { SerializedThread } from "#compiled/chat/index.js";

function space(
  thread: Pick<SerializedThread, "adapterName" | "channelId" | "isDM"> | null,
  extra: Partial<ChatSdkChannelState> = {},
) {
  const state = { thread: thread && { _type: "chat:Thread", id: "t1", ...thread }, ...extra };
  return chatSdkInstrumentation.space({ state: state as ChatSdkChannelState });
}

describe("chat SDK space", () => {
  it("namespaces the channel by adapter once", () => {
    expect(space({ adapterName: "slack", channelId: "slack:C1", isDM: false })).toEqual({
      id: "slack:C1",
      type: "shared",
    });
    expect(space({ adapterName: "whatsapp", channelId: "123", isDM: true })).toEqual({
      id: "whatsapp:123",
      type: "direct",
      visibility: "private",
    });
  });

  it("reads visibility from the channel's visibility, when the adapter reports it", () => {
    const thread = { adapterName: "slack", channelId: "slack:C1", isDM: false };
    expect(space({ ...thread, channelVisibility: "workspace" } as never)?.visibility).toBe(
      "public",
    );
    expect(space({ ...thread, channelVisibility: "private" } as never)?.visibility).toBe("private");
    expect(space(thread)).not.toHaveProperty("visibility");
  });

  it("reports none without a thread, or when a thread ID can't say whether it is a DM", () => {
    expect(space(null)).toBeUndefined();
    expect(
      space({ adapterName: "slack", channelId: "slack:D1", isDM: false }, { spaceUnknown: true }),
    ).toBeUndefined();
  });
});
