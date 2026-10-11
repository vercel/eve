import { defineDynamic, defineSkill } from "eve/skills";

import { choosePlaybook } from "#lib/decisions.js";

const playbooks = {
  "incident-response": defineSkill({
    description: "Coordinate an active production incident.",
    markdown:
      "For an incident, establish impact, current mitigation, owner, and next update time before drafting a status update.",
  }),
  "customer-escalation": defineSkill({
    description: "Handle an unhappy customer or a support escalation.",
    markdown:
      "For a customer escalation, acknowledge the impact, separate confirmed facts from investigation, and name a clear next step and owner.",
  }),
};

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const playbook = await choosePlaybook({
        messages: ctx.messages,
        abortSignal: ctx.abortSignal,
      });
      return playbook ? { [playbook]: playbooks[playbook] } : null;
    },
  },
});
