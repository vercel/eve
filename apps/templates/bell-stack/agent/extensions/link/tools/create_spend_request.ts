import { create_spend_request } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";
import { linkMetadataRequest, spendRequestMetadata } from "../lib/spend-requests";
import { rememberSandboxRequest, sandboxPurchase } from "../../../../server/link/sandbox";

export default defineTool({
  description: create_spend_request.description,
  inputSchema: create_spend_request.inputSchema,
  // Preserve the extension's always() approval policy.
  approval: create_spend_request.approval,
  async execute(input, ctx) {
    ctx.abortSignal.throwIfAborted();
    const result = spendRequestMetadata(await linkMetadataRequest(() => create_spend_request.execute(sandboxPurchase(input), freshLinkContext(ctx, undefined, "create"))));
    rememberSandboxRequest(result.id);
    return result;
  },
});
