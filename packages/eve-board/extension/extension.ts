import { defineExtension } from "eve/extension";
import { BOARD_PROFILE_PATTERN } from "eve/internal/board";
import { z } from "zod";

const name = z
  .string()
  .regex(BOARD_PROFILE_PATTERN, "a letter, then up to 31 letters, numbers, or hyphens");
const permission = z.enum(["read", "post", "react", "label", "sync", "manage"]);
const grant = z.union([z.literal("all"), z.array(permission)]);

/**
 * Makes the agent a participant on a Vercel Board: matching posts and claimed tasks wake it, each
 * board thread is a session, and board tools let it read, post, schedule, and settle tasks.
 */
export default defineExtension({
  config: z.object({
    /** Which of the team's boards, by name. Defaults to the team's default board, or `BOARD_URL`'s. */
    name: z.string().min(1).max(64).optional(),
    /** Another team's board, by its ID (`team_…`) or slug. */
    team: z.string().min(1).optional(),
    /**
     * What wakes the agent: what you'd type after `vb tail`. Without it, `watchers`, or `worker`,
     * the mount contributes the tools and skill, and the channel registers nothing.
     */
    tail: z.string().min(1).optional(),
    /**
     * Several watchers, by name, instead of `tail`: one per task, each with its own sessions and
     * optional context added before its turns.
     */
    watchers: z
      .record(name, z.object({ tail: z.string().min(1), context: z.array(z.string()).optional() }))
      .optional(),
    /** Claims ready tasks from the board's queue, up to `concurrency` at once. */
    worker: z
      .object({
        channel: z.string().min(1),
        label: z.record(z.string(), z.string()).optional(),
        from: z.array(z.string().min(1)).optional(),
        concurrency: z.number().int().min(1).max(50).optional(),
        lease: z.number().int().min(30).max(300).optional(),
        context: z.array(z.string()).optional(),
      })
      .optional(),
    /** The profile the agent writes as on the board. Defaults to `"eve"`. */
    profile: name.optional(),
    /** Also register from preview deployments. */
    previews: z.boolean().optional(),
    /**
     * What the board tools may do at most, below what the deployment may, such as
     * `{ "intake/": ["read", "post", "react", "label"] }`. Defaults to the deployment's access.
     */
    can: z.union([grant, z.record(z.string(), grant)]).optional(),
  }),
});
