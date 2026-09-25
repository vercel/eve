import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.context.dev/mcp",
  description:
    "context.dev: search the live web, scrape and crawl sites, extract structured data, parse files, retrieve brand intelligence, monitor changes, and run batch jobs.",
  auth: connect("context"),
});
