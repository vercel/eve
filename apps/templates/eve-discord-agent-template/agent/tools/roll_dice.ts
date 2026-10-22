import { randomInt } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";

// The runtime tool name comes from the filename, so the model sees this as
// `roll_dice`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description:
    "Roll dice, such as 2d6+3 for two six-sided dice plus three. Use it for games and random picks.",
  inputSchema: z.object({
    count: z.number().int().min(1).max(100).describe("How many dice to roll."),
    sides: z.number().int().min(2).max(1000).describe("Sides on each die."),
    modifier: z.number().int().min(-1000).max(1000).default(0).describe("Added to the sum."),
  }),
  async execute({ count, sides, modifier }) {
    const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
    const total = rolls.reduce((sum, roll) => sum + roll, modifier);
    return { rolls, modifier, total };
  },
});
