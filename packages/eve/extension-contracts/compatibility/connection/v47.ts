import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 47 reached the v26 stream event types through client results; epoch 48 replaces
// them with v27 session events. Connections that don't read session events keep working.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
