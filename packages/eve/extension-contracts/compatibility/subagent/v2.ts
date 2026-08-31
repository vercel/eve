import { defineAgent, defineDynamic, defineRemoteAgent } from "#public/index.js";

const remote = defineRemoteAgent({
  description: "Handle requests remotely.",
  url: "https://agent.example.com",
});

export const dynamic = defineDynamic({
  events: {
    "session.started": () => ({ remote }),
  },
});

export default defineAgent({
  description: "Investigate requests that need deeper research.",
  model: "openai/gpt-5.5",
});
