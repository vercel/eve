// Existing callbacks remain valid when the runtime supplies session.context.
import { defineMcpClientConnection } from "#public/connections/index.js";
export default defineMcpClientConnection({
  description: "Search the documentation.",
  url: "https://docs.example.com/mcp",
  headers: (ctx) => ({ "X-Session": ctx.session.id }),
});
