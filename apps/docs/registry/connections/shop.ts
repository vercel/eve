import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.shop.com",
  description:
    "Shop: find products, manage carts, orders and delegated budgets, and approve purchases with saved cards.",
  auth: connect("shop"),
});
