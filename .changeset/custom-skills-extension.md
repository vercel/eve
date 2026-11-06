---
"eve": minor
---

Add `eve/extensions/custom-skills`, which lets the people talking to an agent save their own versioned skills, personal or shared with a Slack channel.

Each skill has immutable versions and one live version, with drafts, approval-gated publish and rollback, and `always`, `on-demand`, or `deferred` application modes. Skills are stored in any `eve/memory/file` document backend, Vercel Blob by default, or in your own `SkillRepository`.
