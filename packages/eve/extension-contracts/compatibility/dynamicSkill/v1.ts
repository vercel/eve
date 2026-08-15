import { defineDynamic, defineSkill } from "#public/skills/index.js";

/**
 * Epoch 1 resolves a per-principal skill from `session.started` and
 * `turn.started`, ignoring the event body entirely.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const team = ctx.session.auth.current?.attributes.team;
      return typeof team === "string"
        ? defineSkill({
            description: `Escalation playbook for the ${team} team.`,
            markdown: `# ${team} playbook\n\nFollow the ${team} escalation path.`,
          })
        : null;
    },
    "turn.started": () => null,
  },
});
