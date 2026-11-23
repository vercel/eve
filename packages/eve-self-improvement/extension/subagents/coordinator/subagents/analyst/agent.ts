import { defineAgent, defineDynamic } from "eve";
import extension from "../../../../extension.js";

export default defineAgent({
  description:
    "Form a falsifiable capability/UX improvement hypothesis or assess actual PR feedback; available only to the scheduled controller.",
  defaultTools: false,
  model: defineDynamic(() => extension.config.models.analyst),
  limits: { sessionTimeoutMs: 600000 },
});
