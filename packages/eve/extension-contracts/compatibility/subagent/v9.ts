import { defineAgent, defineDynamic, defineRemoteAgent } from "#public/index.js";

export const dynamic = defineDynamic({
  events: {
    "session.started": () =>
      defineRemoteAgent({
        description: "Handle requests remotely.",
        url: "https://agent.example.com",
      }),
  },
});

export default defineAgent({
  description: "Delegate research tasks.",
  model: "anthropic/claude-sonnet-5",
});
