import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.firecrawl.dev/v2/mcp",
  description:
    "Firecrawl: search the live web, scrape pages as LLM-ready markdown or structured JSON, map site URLs, crawl multi-page sites, parse files, and monitor pages for changes.",
  headers: () => ({
    "x-api-key": process.env.FIRECRAWL_API_KEY!,
  }),
});
