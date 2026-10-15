import { describe, expect, it } from "vitest";

import { withChannelConversation } from "#internal/testing/channel-conformance/harness.js";
import { recallDriver } from "#internal/testing/channel-conformance/recall-driver.js";

const ASIDE = "I think the staging numbers looked fine";

describe("recallChannel listening", () => {
  it("hears talk that isn't addressed to it without a model call or withdrawing an approval", async () => {
    await withChannelConversation(
      recallDriver({ overheard: (text) => text === ASIDE }),
      async (conversation) => {
        await conversation.say('Use deploy_release to ship release "v2.4".');
        await conversation.waitForQuestion("Deploy release v2.4 to production?");

        // The requester's own message would cancel the approval if it started a turn.
        await conversation.say(ASIDE);
        await conversation.waitForRest();
        expect(await conversation.replyCount()).toBe(0);

        await conversation.say("approve");
        expect(await conversation.waitForToolResult("deploy_release")).toEqual({ deployed: true });
      },
    );
  }, 60_000);
});
