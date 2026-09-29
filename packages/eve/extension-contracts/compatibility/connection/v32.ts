import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 32 tool-call action requests had no `parentCallId`; epoch 33 adds it as optional.
// Connection approval policies keep receiving the qualified tool name.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
