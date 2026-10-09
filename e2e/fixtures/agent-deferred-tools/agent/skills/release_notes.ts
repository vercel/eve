import { defineSkill } from "eve/skills";

export default defineSkill({
  description: "Write customer-facing release notes for billing changes.",
  deferred: true,
  markdown: [
    "# Release notes",
    "",
    "Lead with what customers will notice.",
    "",
    "release-notes-skill-ok-L3M8",
  ].join("\n"),
});
