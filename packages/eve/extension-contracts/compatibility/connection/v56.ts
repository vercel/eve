// Epoch 56 of the connection capability. Epoch 57 changes only the sandbox environment type it
// reaches (an opaque provider runtime); connection authoring is unchanged, as this example shows.
import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read Bob's calendar.",
  url: "https://calendar.example.com/mcp",
});
