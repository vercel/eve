import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://api.brex.com/mcp",
  description: "Brex: expenses, cards, budgets, and cash.",
  auth: connect("brex"),
});
