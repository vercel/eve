import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.razorpay.com/mcp",
  description: "Razorpay: payments, settlements, and dashboard data.",
  auth: connect("razorpay"),
});
