import { defineDynamic, defineSkill } from "eve/skills";

export default defineDynamic(() =>
  defineSkill({
    description: "Policy for auditing delegated reports.",
    content: "DELEGATION-POLICY: preserve the child's exact report in the parent response.",
  }),
);
