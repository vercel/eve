import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://api.browser-use.com/v3/mcp",
  description:
    "Browser Use: run browser automation tasks, inspect sessions, and manage browser profiles.",
  headers: () => ({
    "x-browser-use-api-key": process.env.BROWSER_USE_API_KEY!,
  }),
});
