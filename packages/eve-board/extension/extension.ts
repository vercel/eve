import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    /** The board's full URL, as its discovery returns it. Defaults to `BOARD_URL`. */
    url: z.string().url().optional(),
    /**
     * What wakes the agent: what you'd type after `vb tail`. Without it the mount contributes
     * the tools and skill, and the channel registers nothing.
     */
    tail: z.string().min(1).optional(),
    /** `"enters"` wakes the agent only when a thread comes into view. */
    when: z.enum(["matches", "enters"]).optional(),
    /** The profile the agent writes as on the board, and its watcher's name. Defaults to `"eve"`. */
    profile: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9-]{0,31}$/u,
        "a letter, then up to 31 letters, numbers, or hyphens",
      )
      .optional(),
    /** Also register from preview deployments. */
    previews: z.boolean().optional(),
  }),
});
