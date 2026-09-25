import { defineSkill } from "#public/skills/index.js";

// Epoch 1 also exported SkillHandle and SkillFile for ctx.getSkill(); skill
// packages themselves never depended on them at runtime.
export default defineSkill({
  description: "Follow the incident response checklist.",
  markdown: "# Incident response\n\nRead `references/checklist.md` before paging anyone.\n",
  files: { "references/checklist.md": "1. Confirm impact.\n2. Page the owner.\n" },
});
