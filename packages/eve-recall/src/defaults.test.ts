import { describe, expect, it, vi } from "vitest";

import { matchSpokenOption, recallSignIns } from "./defaults.js";

const approvalOptions = [
  { id: "approve", label: "Approve" },
  { id: "cancel", label: "Cancel" },
];

/** Event-handler context with a stubbed chat send that answers `sent` for each call in turn. */
function handlerContext(state: Record<string, unknown>, sent: boolean[] = []) {
  const sendChatMessage = vi.fn(async () => sent.shift() ?? true);
  const recall = {
    botId: "bot_1",
    platform: "zoom",
    sendChatMessage,
    supportsDirectMessages: true,
  };
  return { channel: { recall, state } as never, sendChatMessage };
}

describe("matchSpokenOption", () => {
  it.each([
    ["Okay Eve, approve.", "approve"],
    ["Eve, approve it", "approve"],
    ["Eve, one", "approve"],
    ["eve option two please", "cancel"],
    ["let's go with the first", "approve"],
    ["the first one", "approve"],
    ["Eve, the second one", "cancel"],
    ["neither, approve is wrong", undefined],
    ["Eve, what does it deploy?", undefined],
  ])("reads %j as %s", (said, picked) => {
    expect(matchSpokenOption(said, "eve", approvalOptions)?.id).toBe(picked);
  });
});

describe("recall sign-in", () => {
  const signIn = {
    displayName: "Linear",
    interactionId: "interaction_1",
    name: "linear",
    principalId: "recall:bot_1:7",
    url: "https://auth.example.com/device",
    userCode: "ABCD",
  };

  it("keeps the link out of shared chat when the private send fails", async () => {
    const { channel, sendChatMessage } = handlerContext({}, [false]);
    const surface = recallSignIns(channel);

    const delivered = await surface.deliverPrivately!(signIn);
    await surface.postStatus!(signIn, delivered);

    expect(sendChatMessage).toHaveBeenCalledTimes(2);
    const shared = sendChatMessage.mock.calls[1] as unknown[];
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain("can't deliver a private link");
    expect(shared[0]).not.toContain("ABCD");
  });
});
