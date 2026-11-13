import { retrieve_spend_request } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";
import { linkMetadataRequest, spendRequestInput, spendRequestMetadata } from "../lib/spend-requests";

export default defineTool({
  description: "Retrieve a Link spend request's status and approval metadata. Never returns card numbers, security codes, or payment tokens. Use link__checkout to complete an approved purchase with server-side credential entry.",
  inputSchema: spendRequestInput,
  async execute(args, ctx) {
    const input = spendRequestInput.parse(args);
    ctx.abortSignal.throwIfAborted();
    const result = await linkMetadataRequest(() => retrieve_spend_request.execute(input, freshLinkContext(ctx, input.id)));
    return result === null ? null : spendRequestMetadata(result);
  },
});
