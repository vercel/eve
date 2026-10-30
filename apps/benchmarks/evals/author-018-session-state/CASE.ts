import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  category: "features/state",
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      'While drafting customer replies with this agent, our support staff give it style rules mid-conversation, such as "sign off as the Support Team". Add a `save_rule` tool that takes a rule `name` and the `rule` text, and a `list_rules` tool that returns every rule saved so far, so the agent can apply them later in the conversation without being told again. Rules belong to the conversation they were given in; other conversations must not see them. They also have to survive server restarts and redeploys during a long-running conversation. Don\'t add a database or any other external service.',
    );
  },
});
