import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Triage customer support requests: clarify the issue, identify next investigation steps, and draft empathetic follow-up.",
  model: "anthropic/claude-sonnet-5",
  tool: false,
});
