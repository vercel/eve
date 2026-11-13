import { request_spend_approval } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";
import { linkMetadataRequest, spendApprovalMetadata, spendRequestInput } from "../lib/spend-requests";

export default defineTool({
  description: request_spend_approval.description,
  approval: request_spend_approval.approval,
  inputSchema: spendRequestInput,
  async execute(args, ctx) {
    const input = spendRequestInput.parse(args);
    ctx.abortSignal.throwIfAborted();
    return spendApprovalMetadata(await linkMetadataRequest(() => request_spend_approval.execute(input, freshLinkContext(ctx, input.id))));
  },
});
