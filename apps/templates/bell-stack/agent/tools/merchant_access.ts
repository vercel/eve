import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { runBrowserOperation, runCancelableBrowserWork } from "../lib/browser-runtime";
import { allowedMerchantUrl } from "../../server/merchant-access";
import { verifiedMerchantAccess } from "../../server/verified-merchant";

export default defineTool({
  description:
    "Open an allowlisted Baselayer-protected URL with a fresh L2 credential and nonce-bound proof in this conversation's existing browser. Returns access status only. Snapshot and screenshot afterward. Later protected navigations need this tool again. Never purchases or checks out.",
  inputSchema: z.object({ url: z.string().url().max(2048) }),
  execute({ url }, ctx) {
    const target = allowedMerchantUrl(url).href;
    return runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () =>
      runBrowserOperation(ctx.session.id, (browser) =>
        browser.withHostedPage(ctx.abortSignal, (page, connectUrl) =>
          verifiedMerchantAccess(page, connectUrl, target, ctx.abortSignal),
        ),
      ),
    );
  },
  toModelOutput(output) {
    return toolOutput.json(output.result);
  },
});
