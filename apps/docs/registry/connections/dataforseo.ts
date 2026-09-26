import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.dataforseo.com/v3/mcp",
  description:
    "DataForSEO: run SEO, keyword, and SERP data lookups through DataForSEO's MCP server.",
  headers: () => {
    const login = process.env.DATAFORSEO_LOGIN!;
    const password = process.env.DATAFORSEO_PASSWORD!;
    const token = Buffer.from(`${login}:${password}`).toString("base64");
    return {
      Authorization: `Basic ${token}`,
    };
  },
});
