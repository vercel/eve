import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://tellme.embat.io/mcp",
  description: "Embat: cash, debt, payments, and accounting.",
  auth: connect("embat"),
});
