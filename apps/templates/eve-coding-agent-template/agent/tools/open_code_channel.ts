import { openCodeChannel } from "eve/channels/slack";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import slack from "../channels/slack";
import { CODE_CHANNELS } from "../lib/code-channel";

// Only Slack threads can open a code channel, and Slack doesn't open one from
// inside another.
export default defineDynamic((ctx) =>
  CODE_CHANNELS && ctx.channel.kind === "channel:slack" && ctx.channel.metadata.codeChannel !== true
    ? defineTool({
        description: [
          "Move this Slack conversation into a new code channel: a dedicated channel for one task, where you continue the work with the conversation so far.",
          "Open one for multi-step work: code changes, builds, tests, pull requests, investigations, or long output. Answer in place when one message answers the request.",
          "Call it once per request. Slack links the new channel in this thread, so after it opens, reply here in one short sentence at most.",
          'If the status is "unavailable" or Slack refuses, continue here and tell the person why; don\'t retry.',
        ].join("\n"),
        inputSchema: z.object({
          message: z
            .string()
            .min(1)
            .describe(
              "The first message of the code channel's session: the task and where to start. It sees the conversation so far.",
            ),
          name: z
            .string()
            .min(1)
            .max(80)
            .describe("Short title for the channel, such as `Fix the flaky login test`."),
        }),
        async execute({ message, name }, ctx) {
          return await openCodeChannel(ctx, slack, message, { name });
        },
      })
    : null,
);
