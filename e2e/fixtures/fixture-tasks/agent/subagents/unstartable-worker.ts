import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  description: "Intentionally fail remote-agent fetch for deterministic task evals.",
  url: "http://127.0.0.1:1",
});
