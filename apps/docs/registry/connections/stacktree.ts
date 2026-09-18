import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://api.stacktr.ee/mcp",
  description:
    "Stacktree: publish HTML to a live private link, update it in place so an already-sent link stays current, gate pages with a passcode or one email domain, file pages under client spaces, and read viewer feedback.",
  headers: () => ({
    authorization: `Bearer ${process.env.STACKTREE_API_KEY!}`,
  }),
});
