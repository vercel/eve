import { describe, expect, it } from "vitest";

import { withChannelConversation } from "#internal/testing/channel-conformance/harness.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";
import { defineSlackRenderer } from "#public/channels/slack/renderers.js";

const PROMPT = "What should the review cover?";
const REPLY = "Mostly the billing migration";
const DAY_PROMPT = "Which day works for the review?";

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

describe("slackChannel interactionCard", () => {
  // https://github.com/vercel/eve/issues/5462
  it("answers a press on a renderer's nested controls and shows the renderer's answered card", async () => {
    const nested = defineSlackRenderer({
      interactionCard(card, next) {
        const parts = next(card);
        const { answer, request, status } = card.interaction;
        if (status === "open" && answer === undefined) {
          const blocks = [{ child_blocks: parts.controls.blocks, type: "container" }];
          return { ...parts, controls: { ...parts.controls, blocks } };
        }
        const text = `${request.prompt} Picked ${answer?.optionId} with <@${card.answeredBy}>`;
        return {
          controls: { blocks: [{ text: { text, type: "mrkdwn" }, type: "section" }], text },
        };
      },
    });
    const driver = slackDriver("shared", { renderers: [nested] });
    await withChannelConversation(driver, async (conversation) => {
      await conversation.say(
        `Use ask_question and set question to: "${DAY_PROMPT}" with label "Saturday" and label "Sunday".`,
      );
      const options = await conversation.waitForQuestion(DAY_PROMPT);
      await conversation.press(options.find((option) => option.label === "Saturday")!);
      expect(await conversation.waitForToolResult("ask_question")).toEqual({
        answer: "Saturday",
        status: "answered",
      });
      const shown = await conversation.shownPrompt(DAY_PROMPT);
      expect(shown.options).toEqual([]);
      expect(shown.text).toContain(`Picked Saturday with ${conversation.personShownAs[0]}`);
    });
  });
});
