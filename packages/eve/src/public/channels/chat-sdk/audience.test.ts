import { describe, expect, it } from "vitest";

import { chatSdkInstrumentation } from "#public/channels/chat-sdk/audience.js";
import type { ChatSdkChannelState } from "#public/channels/chat-sdk/chatSdkChannel.js";
import type { SerializedThread } from "#compiled/chat/index.js";

function space(thread: Pick<SerializedThread, "adapterName" | "channelId" | "isDM"> | null) {
  const state = { thread: thread && { _type: "chat:Thread", id: "t1", ...thread } };
  return chatSdkInstrumentation.space({ state: state as ChatSdkChannelState });
}

describe("chat SDK space", () => {
  it("namespaces the channel by adapter once", () => {
    expect(space({ adapterName: "slack", channelId: "slack:C1", isDM: false })).toEqual({
      id: "slack:C1",
      type: "channel",
    });
    expect(space({ adapterName: "whatsapp", channelId: "123", isDM: true })).toEqual({
      id: "whatsapp:123",
      type: "direct",
    });
  });

  it("reports none without a thread", () => {
    expect(space(null)).toBeUndefined();
  });
});
