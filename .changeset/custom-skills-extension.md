---
"eve": minor
---

Add `eve/extensions/custom-skills`, which lets the people talking to an agent save their own versioned skills, for themselves or shared with everyone in a channel or group chat.

Each skill has immutable versions and one live version, with drafts, publish and rollback, and `always`, `on-demand`, or `deferred` application modes saved per version. A validator and an approval rule you can replace decide which descriptions and instructions are accepted and which changes run, ask a person, or are refused, and the approval card shows the content that would go live. Shared skills follow the conversation's `ctx.conversation.space` on Slack, Discord, Teams, Telegram, and Chat SDK channels. Every skill has a stable ID beside its name. Skills are stored in any `eve/memory/file` document backend, Vercel Blob by default, in a documented, versioned layout whose index lists every scope for admin views, or in your own `SkillRepository` from `eve/extensions/custom-skills/repository`; `eve/extensions/custom-skills/policies` exports the built-in scopes, validator, and approval rule to compose your own.
