import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://asset-management.mcp.cloudinary.com/sse",
  description: "Cloudinary: manage, transform, and deliver image and video assets.",
  auth: connect("cloudinary"),
});
