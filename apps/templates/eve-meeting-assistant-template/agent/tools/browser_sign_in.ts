import { defineTool } from "eve/tools";
import { z } from "zod";

import { reloadSignIns } from "../lib/reload-sign-ins.js";
import { signInLink } from "../lib/sign-in-link.js";

export default defineTool({
  description: [
    "When your browser can't open a page because it isn't signed in, `link` returns a short-lived link to a page where someone signs your browser in and saves it.",
    "After they say they saved, `reload` loads the saved sign-ins into your browser, then open the page again.",
  ].join(" "),
  inputSchema: z.object({ action: z.enum(["link", "reload"]) }),
  async execute({ action }, ctx) {
    if (action === "link") return signInLink();
    await reloadSignIns(ctx);
    return { reloaded: true };
  },
});
