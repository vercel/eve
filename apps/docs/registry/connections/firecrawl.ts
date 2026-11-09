import { always } from "eve/tools/approval";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.firecrawl.dev/v2/mcp",
  description: "Firecrawl: search, scrape, map, crawl, parse, and monitor web content.",
  headers: () => ({
    Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
  }),
  approval: always(),
});
