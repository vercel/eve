import { defineAgent, defineDynamic } from "eve";
import extension from "../../../../extension.js";

export default defineAgent({
  description:
    "Implement and test the controller's active experiment in an isolated Vercel Sandbox; publish through the constrained signed-PR tool.",

  defaultTools: true,
  model: defineDynamic(() => extension.config.models.maintainer),
  limits: { sessionTimeoutMs: 1500000 },
});
