import { defineMcpClientConnection } from "eve/connections";
import { always } from "eve/tools/approval";

export default defineMcpClientConnection({
  url: "https://api.stacktr.ee/mcp",
  description:
    "Stacktree: publish HTML pages to unlisted links, update them in place, set optional passcode or email gates, and manage feedback.",
  approval: always(),
  headers: () => ({
    authorization: `Bearer ${process.env.STACKTREE_API_KEY!}`,
  }),
});
