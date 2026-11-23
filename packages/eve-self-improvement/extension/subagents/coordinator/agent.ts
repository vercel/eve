import { defineAgent, defineDynamic } from "eve";
import extension from "../../extension.js";

export default defineAgent({
  description:
    "Resume the scheduled self-improvement state machine. Use analyst/maintainer subagents and the enforcing step tool; return confirmed persisted outcomes only.",
  defaultTools: false,
  model: defineDynamic(() => extension.config.models.analyst),
  limits: { sessionTimeoutMs: 3600000 },
});
