import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { readVaultItems } from "@db/services/vault";

export default defineTool({
  description:
    "List safe metadata and opaque handles for saved logins, payment methods, contact or traveler details, and addresses. Check this before declaring that routine form information is missing. Never returns secret values.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const items = await readVaultItems(await requireWorkerScope(ctx));
    return items.map(({ account, hasSecret, id, kind, label }) => ({
      account,
      available: hasSecret,
      handle: id,
      kind,
      label,
    }));
  },
});
