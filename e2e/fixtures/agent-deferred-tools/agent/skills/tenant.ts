import { defineDynamic, defineSkill } from "eve/skills";

/** A deferred dynamic skill resolved for each session. */
export default defineDynamic({
  resolve: () => ({
    "tenant-playbook": defineSkill({
      description: "The tenant's escalation playbook for billing disputes.",
      deferred: true,
      markdown: [
        "# Tenant playbook",
        "",
        "Escalate disputes over $500.",
        "",
        "tenant-playbook-ok-T9P4",
      ].join("\n"),
    }),
  }),
});
