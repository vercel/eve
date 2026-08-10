import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  description: "Intentionally fail before remote-agent fetch for deterministic task evals.",
  url: "not-a-valid-remote-agent-url",
});
