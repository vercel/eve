// Retained connection epoch 54: existing authoring works with proactive session preparation.
import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read reports from the tracker.",
  url: "https://tracker.example.com/mcp",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: "service-credential" }),
  },
});
