import { retrieve_spend_request } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext, linkPrincipal } from "../../../lib/link-auth";
import { runBrowserOperation, runCancelableBrowserWork } from "../../../lib/browser-runtime";
import { checkoutInHostedPage } from "../../../../server/link/checkout-browser";
import { checkoutInput, paymentOrigins } from "../../../../server/link/payment";
import { isLinkSandbox } from "../../../../server/link/sandbox";
import { linkMetadataRequest } from "../lib/spend-requests";

export default defineTool({
  description: "Submit an already-approved Link purchase in the existing browser. Supply exact CSS payment-field mappings and the approved amount/currency. Virtual-card values stay server-side. Shared Payment Tokens and Link Pay Tokens require a separate integration and are not accepted. Use only once per purchase; an uncertain outcome requires checking the merchant and Link before any retry. Human handoff remains available for 3DS.",
  inputSchema: checkoutInput,
  async execute(args, ctx) {
    const input = checkoutInput.parse(args);
    linkPrincipal(ctx);
    ctx.abortSignal.throwIfAborted();
    const retrieve = (include?: [typeof input.credential]) => linkMetadataRequest(() => retrieve_spend_request.execute({ id: input.id, ...(include ? { include } : {}) }, freshLinkContext(ctx, input.id)));
    const origins = paymentOrigins(await retrieve(), input);
    const output = await runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () => runBrowserOperation(ctx.session.id, browser => browser.withHostedPage(ctx.abortSignal, (page, connection) =>
      checkoutInHostedPage(page, connection, input, origins, async () => {
        const result = await retrieve([input.credential]);
        if (JSON.stringify(paymentOrigins(result, input)) !== JSON.stringify(origins)) throw new Error("Link approval changed.");
        return result;
      }, ctx.abortSignal), true)));
    return isLinkSandbox() ? { ...output.result, test: true } : output.result;
  },
});
