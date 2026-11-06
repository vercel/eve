import { defineTool } from "eve/tools";

import { z } from "#compiled/zod/index.js";

import { executeSearch } from "../lib/search.js";
import extension from "../extension.js";
import { slackTurn } from "../lib/turn.js";

export default defineTool({
  description:
    "Search public Slack channels across the workspace, best match first, with channel, author, text, timestamp, and permalink for each match. The bot does not need to be in the channels it searches. Never searches private channels or direct messages. Works only in a turn started by a Slack message, on an authorization that expires a few minutes after that message, so run searches early. For a request about one calendar day, pass onDate.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Natural-language description of what you're looking for, e.g. 'who owns the billing service'.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum number of matches to return."),
    onDate: z.iso
      .date()
      .optional()
      .describe(
        "Exact calendar day in YYYY-MM-DD form, with the four-digit year. Use it for any request tied to one day, including today or yesterday.",
      ),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("nextCursor from a previous search with the same query, to get more matches."),
  }),
  label: { start: () => "Searching Slack" },
  execute: (input, ctx) =>
    executeSearch(input, slackTurn(ctx.session.auth.current, extension.config)),
});
