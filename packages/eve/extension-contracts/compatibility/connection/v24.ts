import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 24 resolver contexts also exposed getSkill(); connection options are unchanged.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.startsWith("search") ? "approved" : "user-approval";
  },
});
