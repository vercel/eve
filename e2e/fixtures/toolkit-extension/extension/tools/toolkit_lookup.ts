import { defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension";

export default defineTool({
  description:
    "Look up an account in the toolkit CRM. Returns the resolved account plus the " +
    "toolkit config the extension was mounted with. Call when asked to look up an account.",
  inputSchema: z.object({ account: z.string() }),
  async execute({ account }) {
    const { apiKey, tier } = extension.config;
    return { account, apiKey, tier };
  },
});
