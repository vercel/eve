import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Coordinate production incidents: establish impact, mitigation, owners, and status updates.",
  model: "anthropic/claude-sonnet-5",
  tool: false,
});
