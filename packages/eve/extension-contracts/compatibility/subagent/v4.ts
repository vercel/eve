import { defineAgent, defineRemoteAgent } from "#public/index.js";

export const local = defineAgent({
  description: "Summarize long documents.",
  model: "anthropic/claude-sonnet-5",
});

export const remote = defineRemoteAgent({
  description: "Review remotely.",
  url: "https://review.example.com",
});
