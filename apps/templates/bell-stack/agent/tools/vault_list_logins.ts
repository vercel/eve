import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { onePasswordVault } from "../../server/browser/vault/onepassword.js";
import { nativeVault } from "../../server/browser/vault/native.js";

export default defineTool({
  description:
    "List safe login metadata and opaque item IDs from configured vaults. No secret values are returned. Use the returned provider and IDs, and choose only an item whose allowedHosts contains the current page host.",
  inputSchema: z.object({ provider: z.enum(["native", "onepassword"]).optional() }),
  async execute({ provider }, ctx) {
    if (ctx.session.auth?.current?.authenticator === "linq-message") throw new Error("Shared operator vaults are not available over iMessage. Use onepassword_login for personal credentials.");
    const items = [];
    if (provider === "native" || (!provider && process.env.BELL_VAULT_MASTER_KEY?.trim()))
      items.push(...await nativeVault.list());
    if (provider === "onepassword" || (!provider &&
      (process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim() || process.env.OP_ACCOUNT?.trim())))
      items.push(...(await onePasswordVault.list()).map((item) => ({ ...item, provider: "onepassword" as const })));
    return { items };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
