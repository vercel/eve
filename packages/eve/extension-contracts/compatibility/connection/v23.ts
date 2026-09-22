import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read caller-specific catalog items.",
  url: "https://catalog.example.com/mcp",
  toolCall: {
    providedArguments: {
      tenant: ({ session }) => session.id,
    },
  },
});
