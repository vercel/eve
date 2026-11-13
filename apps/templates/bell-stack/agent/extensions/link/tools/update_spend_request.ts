import { update_spend_request } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";
import { linkMetadataRequest, spendRequestMetadata, validateSpendRequestId } from "../lib/spend-requests";

export default defineTool({
  description: "Update a Link spend request and return approval/status metadata only. Use link__checkout for server-side credential entry after approval.",
  inputSchema: update_spend_request.inputSchema,
  approval: update_spend_request.approval,
  async execute(input, ctx) {
    validateSpendRequestId(input);
    ctx.abortSignal.throwIfAborted();
    return spendRequestMetadata(await linkMetadataRequest(() => update_spend_request.execute(input, freshLinkContext(ctx, input.id))));
  },
});
