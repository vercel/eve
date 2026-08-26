import { defineLocalSubagent, defineRemoteSubagent } from "#public/index.js";

export const local = defineLocalSubagent({
  background: true,
  description: "Delegate research tasks.",
  model: "anthropic/claude-sonnet-5",
});

export const remote = defineRemoteSubagent({
  background: false,
  description: "Delegate review tasks.",
  url: "https://review.example.com",
});
