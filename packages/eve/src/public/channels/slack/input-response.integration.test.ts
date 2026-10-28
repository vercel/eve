import { describe, expect, it } from "vitest";

import { withChannelConversation } from "#internal/testing/channel-conformance/harness.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";

const PROMPT = "What should the review cover?";
const REPLY = "Mostly the billing migration";

describe("slackChannel onAnswers", () => {
  // https://github.com/vercel/eve/issues/5074
  it("keeps a typed thread reply from answering a question the hook would refuse", async () => {
    const driver = slackDriver("shared", { onAnswers: () => null });
    await withChannelConversation(driver, async (conversation) => {
      await conversation.say(`Use ask_question and set question to: "${PROMPT}"`);
      await conversation.waitForQuestion(PROMPT);
      await conversation.say(REPLY);
      await conversation.waitForRest();
      const shared = await conversation.sharedText();
      expect(shared, `ask_question took the typed reply: ${shared}`).not.toContain(
        '"status":"answered"',
      );
      // The reply reaches the agent as a new message instead.
      await conversation.waitForReplyTo(REPLY);
    });
  });
});
