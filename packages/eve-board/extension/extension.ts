import { defineExtension } from "eve/extension";
import { BOARD_PROFILE_PATTERN } from "eve/internal/board";
import { z } from "zod";

const name = z
  .string()
  .regex(BOARD_PROFILE_PATTERN, "a letter, then up to 31 letters, numbers, or hyphens");
const when = z.enum(["matches", "enters"]);

export default defineExtension({
  config: z.object({
    /** The board's full URL, as its discovery returns it. Defaults to `BOARD_URL`. */
    url: z.string().url().optional(),
    /**
     * What wakes the agent: what you'd type after `vb tail`. Without it or `watchers`, the mount
     * contributes the tools and skill, and the channel registers nothing.
     */
    tail: z.string().min(1).optional(),
    /** `"enters"` wakes the agent only when a thread comes into view. */
    when: when.optional(),
    /**
     * Several watchers, by name, instead of `tail`: one per task, each with its own sessions and
     * optional context added before its turns.
     */
    watchers: z
      .record(
        name,
        z.object({
          tail: z.string().min(1),
          when: when.optional(),
          context: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    /** The profile the agent writes as on the board. Defaults to `"eve"`. */
    profile: name.optional(),
    /** Also register from preview deployments. */
    previews: z.boolean().optional(),
  }),
});
