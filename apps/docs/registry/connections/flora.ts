import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { always } from "eve/tools/approval";

export default defineMcpClientConnection({
  url: "https://agents.flora.ai/mcp",
  description: "FLORA: generate image, video, audio, text, and 3D assets on a canvas.",
  auth: connect("agents.flora.ai/flora"),
  approval: always(),
});
