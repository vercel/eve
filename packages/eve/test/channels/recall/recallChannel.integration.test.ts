import { describe, expect, it } from "vitest";

import { withChannelConversation } from "#internal/testing/channel-conformance/harness.js";
import { recallDriver } from "./recall-driver.js";

const ASIDE = "I think the staging numbers looked fine";

describe("recallChannel listening", () => {
  it("hears talk that isn't addressed to it without a model call or withdrawing an approval", async () => {
    const heard: (readonly string[])[] = [];
    await withChannelConversation(
      recallDriver({
        overheard: (text) => text === ASIDE,
        // The default: chat, and speech that names the bot.
        shouldRespond: ({ event, line, transcript }) => {
          heard.push(transcript);
          return event.type === "chat" || line.includes("Eve");
        },
      }),
      async (conversation) => {
        await conversation.say('Use deploy_release to ship release "v2.4".');
        await conversation.waitForQuestion("Deploy release v2.4 to production?");

        // The requester's own message would cancel the approval if it started a turn.
        await conversation.say(ASIDE);
        await conversation.waitForRest();
        expect(await conversation.replyCount()).toBe(0);

        await conversation.say("approve");
        expect(await conversation.waitForToolResult("deploy_release")).toEqual({ deployed: true });
        await conversation.waitForRest();

        // What it heard while the approval was open reaches its next turn.
        await conversation.say("What did I miss?");
        await conversation.waitForReplyTo("What did I miss?");
        expect(heard.at(-1)).toEqual([`Alice: ${ASIDE}`]);
      },
    );
  }, 60_000);
});

describe("recallChannel private chat", () => {
  it("declines a private chat privately without starting a turn", async () => {
    const note = "My review score for Bob is 2 out of 5.";
    await withChannelConversation(
      recallDriver({ privately: (text) => text === note }),
      async (conversation) => {
        await conversation.say(note);
        await conversation.waitForShown(/can't take private messages/u);
        await conversation.waitForRest();

        expect(await conversation.replyCount()).toBe(0);
        expect(await conversation.sharedText()).not.toContain("private messages");
      },
    );
  }, 60_000);
});

describe("recallChannel spoken answers", () => {
  it.each([
    ["Okay Eve, approve it.", "approve"],
    ["Eve, one.", "1"],
  ])(
    "approves when someone says %j",
    async (said, answer) => {
      await withChannelConversation(
        recallDriver({
          input: "speech",
          spoken: (text) => (text === answer ? said : `Eve, ${text}`),
        }),
        async (conversation) => {
          await conversation.say('Use deploy_release to ship release "v2.4".');
          await conversation.waitForQuestion("Deploy release v2.4 to production?");
          await conversation.say(answer);
          expect(await conversation.waitForToolResult("deploy_release")).toEqual({
            deployed: true,
          });
        },
      );
    },
    60_000,
  );
});
