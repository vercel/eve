import { agentRouter } from "eve/tools/agent-router";

export default agentRouter({
  instructions: "Which agent should handle this fixture task?",
  model: "typesafe-ai/jev",
});
