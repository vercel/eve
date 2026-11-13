import { list_spend_requests } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";
import { linkMetadataRequest, spendRequestListMetadata } from "../lib/spend-requests";

export default defineTool({
  description: list_spend_requests.description,
  inputSchema: list_spend_requests.inputSchema,
  approval: list_spend_requests.approval,
  async execute(input, ctx) {
    ctx.abortSignal.throwIfAborted();
    return spendRequestListMetadata(await linkMetadataRequest(() => list_spend_requests.execute(input, freshLinkContext(ctx, undefined, "list"))));
  },
});
