import { defineExtension } from "eve/extension";
import { z } from "zod";

export type { DetectedLoop, LoopPattern } from "./lib/loops.ts";

const threshold = z.union([z.number().int().min(2), z.literal(false)]);

export default defineExtension({
  config: z
    .object({
      /** How many of the turn's most recent calls the checks look at. */
      window: z.number().int().min(2).max(50).default(10),
      /**
       * A loop when the same call (same tool, same input) is made this many times within
       * `window`, whatever it returned. `false` turns the check off.
       */
      repeatedCall: threshold.default(5),
      /**
       * A loop when the same call returns the same result this many times in a row. `false`
       * turns the check off.
       */
      repeatedResult: threshold.default(3),
      /**
       * A loop when two different calls are made in turn, A-B-A-B, for this many cycles. `false`
       * turns the check off.
       */
      alternatingCalls: threshold.default(3),
      /**
       * Loops a turn is nudged about before the next one stops it. `0` stops the turn at its
       * first loop.
       */
      maxNudges: z.number().int().min(0).default(1),
    })
    .superRefine((config, ctx) => {
      // A check that can never fire within the window is a mistake, not a way to turn it off.
      const fits = {
        alternatingCalls:
          config.alternatingCalls === false || config.alternatingCalls * 2 <= config.window,
        repeatedCall: config.repeatedCall === false || config.repeatedCall <= config.window,
        repeatedResult: config.repeatedResult === false || config.repeatedResult <= config.window,
      };
      for (const [key, ok] of Object.entries(fits)) {
        if (ok) continue;
        ctx.addIssue({
          code: "custom",
          message: `${key} can never fire within a window of ${config.window} calls. Raise window, lower ${key}, or set it to false.`,
          path: [key],
        });
      }
    }),
});
