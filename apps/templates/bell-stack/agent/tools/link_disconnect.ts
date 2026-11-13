import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getLinkOAuth, safeLinkCall } from "../../server/link/oauth";
import { linkPrincipal } from "../lib/link-auth";
import { isLinkSandbox } from "../../server/link/sandbox";

export default defineTool({
  description: "Disconnect this Linq sender's Link wallet and revoke its OAuth grant. If revocation fails, access stays blocked; retry this tool to finish disconnecting. This does not cancel merchant orders or subscriptions.",
  inputSchema: z.object({}),
  approval: always(),
  async execute(_input, ctx) {
    if (isLinkSandbox()) throw new Error("The sandbox token is managed by its operator. Remove it from the running process and revoke it in Link; Bell has no saved wallet connection to delete.");
    return safeLinkCall(() => {
      return getLinkOAuth().disconnect(linkPrincipal(ctx));
    });
  },
});
