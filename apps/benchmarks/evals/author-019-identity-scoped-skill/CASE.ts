import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  category: "features/skills",
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      [
        "Our support staff work under different data-handling procedures depending on their region, and one region's procedure must never reach staff in another. Give this agent the procedure for whoever is asking. Our sign-in puts the caller's region in the session's auth attributes as `region`. Callers without one of these regions get no procedure, and the region has to come from the signed-in identity, never from anything said in the conversation.",
        "",
        "- `eu`: Store customer attachments only in the Frankfurt bucket and delete them after 30 days.",
        "- `us`: Send any customer data-deletion request to the Virginia privacy desk within one business day.",
      ].join("\n"),
    );
  },
});
