import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read the support queue after approval.",
  url: "https://support.example.com/mcp",
  approval({ toolInput, toolName }) {
    return toolName && toolInput !== undefined ? "user-approval" : "denied";
  },
});
