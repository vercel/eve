import { expect, it } from "vitest";

import {
  deployPrompt,
  GATED_TOOL,
  withChannelConversation,
} from "#internal/testing/channel-conformance/harness.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";
import { teamsDriver } from "#internal/testing/channel-conformance/teams-driver.js";
import { telegramDriver } from "#internal/testing/channel-conformance/telegram-driver.js";

// #4835: an operator cancels a session's run through the workflow world, so
// eve never withdraws its pending approval. A later press reaches no session.
for (const driver of [slackDriver(), teamsDriver(), telegramDriver()]) {
  it.fails(
    `${driver.name}: pressing Approve after the session's run was cancelled outside eve clears the approval's buttons and says it is no longer active`,
    () =>
      withChannelConversation(driver, async (conversation) => {
        const prompt = deployPrompt("v2.4");
        await conversation.say(`Use ${GATED_TOOL} to ship release "v2.4".`);
        const options = await conversation.waitForQuestion(prompt);
        await conversation.cancelRunsInWorld();

        await conversation.press(options.find(({ label }) => label === "Approve")!);

        expect(conversation.runsOf(GATED_TOOL)).toBe(0);
        expect((await conversation.shownPrompt(prompt)).options).toEqual([]);
        await conversation.waitForShown(/no longer active/);
      }),
    60_000,
  );
}
