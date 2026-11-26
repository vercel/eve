import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { BoardAuthorize } from "./lib/authorize.ts";
import { BOARD_CHANNEL_SELECTOR, BOARD_NAME_PATTERN, BOARD_PERMISSIONS } from "./lib/client.ts";
import { isValidBoardRouteBase } from "./lib/route.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function", "expected a function");

const grant = z.union([z.literal("all"), z.array(z.enum(BOARD_PERMISSIONS)).readonly()]);

const profile = z
  .string()
  .regex(BOARD_NAME_PATTERN, "a letter, then up to 31 letters, numbers, or hyphens");

const can = z.union([
  grant,
  z.record(
    z
      .string()
      .refine(
        (pattern) => pattern === "*" || BOARD_CHANNEL_SELECTOR.test(pattern),
        "a channel, a subtree such as `work/`, or `*`",
      ),
    grant,
  ),
]);

const watchChannel = z
  .string()
  .max(200)
  .regex(BOARD_CHANNEL_SELECTOR, "lowercase segments joined by /")
  .refine((channel) => !channel.endsWith("/"), "one channel, not a subtree");

const authorize = fn<BoardAuthorize>();

const boardUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//u.test(value), "an http:// or https:// board URL");

const boardEntry = z.object({
  /** Which of the team's boards, by name. Defaults to the team's default board, or `BOARD_URL`'s. */
  name: z.string().min(1).max(64).optional(),
  /** Another team's board, by its ID (`team_…`) or slug. */
  team: z.string().min(1).optional(),
  /** Direct URL for a local or self-hosted board, overriding `BOARD_URL` for this board. */
  url: boardUrl.optional(),
  /** Profile override for this board. Defaults to the top-level `profile` or `"eve"`. */
  profile: profile.optional(),
  /** What board tools and watches may reach on this board. Defaults to the deployment's access. */
  can: can.optional(),
  /** Channel that keeps watch instructions on this board. Defaults to top-level `watchChannel` or `"eve-config/watches"`. */
  watchChannel: watchChannel.optional(),
  /** Authorizes watch creation, listing, and removal, and `settle_task`, on this board. Defaults to top-level `authorize`. */
  authorize: authorize.optional(),
});

/**
 * Makes the agent a participant on one or more Vercel Boards. The agent creates watches with its
 * `watch` tool when someone asks; each watch's match wakes it in the board thread, or claims a
 * ready task first, and board tools let it read, post, schedule, and settle tasks.
 */
export default defineExtension({
  config: z
    .object({
      /** Which of the team's boards, by name. Defaults to the team's default board, or `BOARD_URL`'s. */
      name: z.string().min(1).max(64).optional(),
      /** Another team's board, by its ID (`team_…`) or slug. */
      team: z.string().min(1).optional(),
      /** Direct URL for a local or self-hosted board, overriding `BOARD_URL`. */
      url: boardUrl.optional(),
      /** The profile the agent writes as on the board. Defaults to `"eve"`. */
      profile: profile.optional(),
      /**
       * What the board tools and watches may reach at most, below what the deployment may, such as
       * `{ "intake/": ["read", "post", "react", "label"] }`. Defaults to the deployment's access.
       */
      can: can.optional(),
      /** The channel that keeps watch instructions, outside every watched channel. Defaults to `"eve-config/watches"`. */
      watchChannel: watchChannel.optional(),
      /** Authorizes watch creation, listing, and removal, and `settle_task`. Defaults to any signed-in caller except non-person board actors. */
      authorize: authorize.optional(),
      /** Base route path for the board wake endpoint (`<route>/wake` or `<route>/:board/wake`). Defaults to `"/eve/v1/board"`. */
      route: z
        .string()
        .min(1)
        .refine(
          isValidBoardRouteBase,
          'an absolute path without parameters or query string, such as "/eve/v1/board"',
        )
        .optional(),
      /** Named boards served by this mount. Do not combine with top-level `name`, `team`, `url`, or `can`. */
      boards: z
        .record(
          z
            .string()
            .regex(BOARD_NAME_PATTERN, "a letter, then up to 31 letters, numbers, or hyphens"),
          boardEntry,
        )
        .optional(),
    })
    .superRefine((value, ctx) => {
      if (value.boards === undefined) return;
      const entries = Object.entries(value.boards);
      if (entries.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "boards must configure at least one board.",
          path: ["boards"],
        });
      }
      if (
        value.name !== undefined ||
        value.team !== undefined ||
        value.url !== undefined ||
        value.can !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Cannot combine `boards` with top-level `name`, `team`, `url`, or `can`; set those fields on each entry in `boards`.",
          path: ["boards"],
        });
      }
      const seenTargets = new Map<string, string>();
      for (const [key, entry] of entries) {
        let target: string;
        if (entry.url !== undefined) {
          const parsed = new URL(entry.url.trim());
          target = JSON.stringify([
            "url",
            `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`,
          ]);
        } else {
          target = JSON.stringify(["vercel", entry.team ?? null, entry.name ?? null]);
        }
        const previous = seenTargets.get(target);
        if (previous !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `boards "${previous}" and "${key}" target the same board; give each entry a distinct \`name\`, \`team\`, or \`url\`.`,
            path: ["boards", key],
          });
        } else {
          seenTargets.set(target, key);
        }
      }
    }),
});
