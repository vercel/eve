import { defineTool } from "eve/tools";
import { z } from "zod";

import { scrollShownPage } from "../lib/stage.js";

export default defineTool({
  description: [
    "Scroll the Notion page you're sharing.",
    "To show a section or line, pass `block`, its id from `read_doc`: Notion jumps to it and highlights it.",
    "Otherwise pass `to`: `down` or `up` by about a screen, or `top` or `bottom`.",
  ].join(" "),
  inputSchema: z.object({
    block: z.string().optional().describe("A block id from `read_doc`."),
    to: z.enum(["up", "down", "top", "bottom"]).optional(),
  }),
  async execute({ block, to }, ctx) {
    if (block === undefined && to === undefined) throw new Error("Pass `block` or `to`.");
    await scrollShownPage(ctx, block !== undefined ? { block } : to!);
    return { scrolled: block ?? to };
  },
});
