import { describe, expect, it, vi } from "vitest";

import type { SignIn } from "#channel/sign-in.js";
import { chatSdkSignIns } from "#public/channels/chat-sdk/authorization.js";
import type { ChatSdkChannelState } from "#public/channels/chat-sdk/chatSdkChannel.js";

type SignInChannel = Parameters<typeof chatSdkSignIns>[0];

const SIGN_IN: SignIn = {
  displayName: "Calendar",
  interactionId: "sign-in-1",
  name: "calendar",
  principalId: "alice",
  url: "https://calendar.test/login",
  userCode: "WXYZ",
};

/** A group thread whose adapter sends ephemerals natively, or falls back to a DM. */
function groupThread(usedFallback: boolean) {
  const editMessage = vi.fn(async () => ({}));
  const postEphemeral = vi.fn(async () => ({
    id: "dm-message-1",
    raw: {},
    threadId: usedFallback ? "adapter:direct-message:U1" : "adapter:group",
    usedFallback,
  }));
  const state: Partial<ChatSdkChannelState> = { usersByPrincipal: { alice: "U1" } };
  // Only what a sign-in touches: the thread it posts to and the state it records in.
  const channel: SignInChannel = {
    state,
    thread: {
      adapter: { editMessage },
      id: "adapter:group",
      isDM: false,
      post: vi.fn(async () => ({ id: "status-1" })),
      postEphemeral,
    },
  } as never;
  return { channel, editMessage, postEphemeral, state };
}

describe("a Chat SDK sign-in sent privately", () => {
  it("replaces the DM it fell back to with how the sign-in ended", async () => {
    const { channel, editMessage, postEphemeral, state } = groupThread(true);
    const surface = chatSdkSignIns(channel)!;

    expect(await surface.deliverPrivately!(SIGN_IN)).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      "U1",
      { markdown: expect.stringContaining(SIGN_IN.url!) },
      { fallbackToDM: true },
    );

    await surface.endPrivately!(SIGN_IN, "Calendar connected.");
    expect(editMessage).toHaveBeenCalledWith("adapter:direct-message:U1", "dm-message-1", {
      markdown: "Calendar connected.",
    });
    expect(state.privateAuthMessages).toEqual({});

    // Only once: a second ending finds nothing left to replace.
    await surface.endPrivately!(SIGN_IN, "Calendar connected.");
    expect(editMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves a native ephemeral alone, since it can't be edited", async () => {
    const { channel, editMessage, state } = groupThread(false);
    const surface = chatSdkSignIns(channel)!;

    expect(await surface.deliverPrivately!(SIGN_IN)).toBe(true);
    expect(state.privateAuthMessages).toBeUndefined();
    await surface.endPrivately!(SIGN_IN, "Calendar connected.");
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("still ends the sign-in when the DM can't be edited", async () => {
    const { channel, editMessage } = groupThread(true);
    editMessage.mockRejectedValueOnce(new Error("message_not_found"));
    const surface = chatSdkSignIns(channel)!;

    await surface.deliverPrivately!(SIGN_IN);
    await expect(surface.endPrivately!(SIGN_IN, "Calendar connected.")).resolves.toBeUndefined();
  });
});
