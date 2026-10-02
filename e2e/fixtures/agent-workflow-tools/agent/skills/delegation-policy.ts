import { defineDynamic, defineSkill } from "eve/skills";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Policy for auditing delegated reports.",
        markdown: "DELEGATION-POLICY: preserve the child's exact report in the parent response.",
      }),
  },
});
