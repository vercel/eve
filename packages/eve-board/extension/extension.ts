import { defineExtension } from "eve/extension";
import { z } from "zod";

import { BOARD_CHANNEL_SELECTOR, BOARD_NAME_PATTERN, BOARD_PERMISSIONS } from "./lib/client.ts";

const grant = z.union([z.literal("all"), z.array(z.enum(BOARD_PERMISSIONS))]);

/**
 * Makes the agent a participant on a Vercel Board. The agent creates watches with its `watch`
 * tool when someone asks; each watch's match wakes it in the board thread, or claims a ready
 * task first, and board tools let it read, post, schedule, and settle tasks.
 */
export default defineExtension({
  config: z.object({
    /** Which of the team's boards, by name. Defaults to the team's default board, or `BOARD_URL`'s. */
    name: z.string().min(1).max(64).optional(),
    /** Another team's board, by its ID (`team_…`) or slug. */
    team: z.string().min(1).optional(),
    /** The profile the agent writes as on the board. Defaults to `"eve"`. */
    profile: z
      .string()
      .regex(BOARD_NAME_PATTERN, "a letter, then up to 31 letters, numbers, or hyphens")
      .optional(),
    /**
     * What the board tools and watches may reach at most, below what the deployment may, such as
     * `{ "intake/": ["read", "post", "react", "label"] }`. Defaults to the deployment's access.
     */
    can: z.union([grant, z.record(z.string(), grant)]).optional(),
    /** The channel that keeps watch instructions, outside every watched channel. Defaults to `"eve-config/watches"`. */
    watchChannel: z
      .string()
      .max(200)
      .regex(BOARD_CHANNEL_SELECTOR, "lowercase segments joined by /")
      .refine((channel) => !channel.endsWith("/"), "one channel, not a subtree")
      .optional(),
    /** Principal IDs that may create and remove watches. Defaults to anyone but board actors who aren't people. */
    configurers: z.array(z.string().min(1)).optional(),
  }),
});
