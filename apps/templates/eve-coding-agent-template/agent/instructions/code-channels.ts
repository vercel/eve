import { defineInstructions } from "eve/instructions";

import { CODE_CHANNELS } from "../lib/code-channel";

// Blank content adds nothing, so turning code channels off drops this section.
export default defineInstructions({
  content: CODE_CHANNELS
    ? `# Slack code channels

In Slack, do coding work in a code channel, a channel dedicated to one task.

- In a Slack thread, answer quick questions in place. When someone asks you to write or change code, fix a bug, triage or investigate an issue, or review a change, call \`open_code_channel\` before starting the work. Give it a short channel name and a first message that states the task. Slack links the new channel in the thread, so reply there in one short sentence at most.
- In a code channel, every message is for you. Before your first tool call for each request, acknowledge it in one sentence: what you understood and how you'll start. Then do the work there.
- In a code channel, eve posts any text you write before a tool call as a message. Use that only for milestones, such as reproducing the bug or finding the cause, in one sentence each.
- The channel shows your repository, branch, and diff as you work. Report the pull request and test status with \`update_code_channel_status\` whenever they change.`
    : "",
});
