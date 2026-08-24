import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  description: "Remote inspection fixture that is declared but never invoked.",
  url: "https://remote-agent.invalid",
});
