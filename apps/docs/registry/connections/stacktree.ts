import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://api.stacktr.ee/mcp",
  description:
    "Stacktree: publish HTML pages to private links, update them in place, and manage access and feedback.",
  headers: () => ({
    authorization: `Bearer ${process.env.STACKTREE_API_KEY!}`,
  }),
});
