import { defineSkill } from "#public/skills/index.js";

export default defineSkill({
  description: "Follow the incident response checklist.",
  markdown: "# Incident response\n\nRead `references/checklist.md` before paging anyone.\n",
  files: { "references/checklist.md": "1. Confirm impact.\n2. Page the owner.\n" },
});
