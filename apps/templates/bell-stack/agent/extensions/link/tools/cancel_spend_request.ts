import { cancel_spend_request } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";
import { linkMetadataRequest, spendRequestInput, spendRequestMetadata } from "../lib/spend-requests";

export default defineTool({
  description: cancel_spend_request.description,
  approval: cancel_spend_request.approval,
  inputSchema: spendRequestInput,
  async execute(args, ctx) {
    const input = spendRequestInput.parse(args);
    ctx.abortSignal.throwIfAborted();
    return spendRequestMetadata(await linkMetadataRequest(() => cancel_spend_request.execute(input, freshLinkContext(ctx, input.id))));
  },
});
