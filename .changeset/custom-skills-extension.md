---
"eve": minor
---

Add `eve/extensions/custom-skills`, which lets the people talking to an agent save their own versioned skills, for themselves or shared with everyone in a channel or group chat.

Each skill has immutable versions and one live version, with drafts, publish and rollback, and `always`, `on-demand`, or `deferred` application modes saved per version. An approval rule you can replace decides which changes run, ask a person, or are refused, and the approval card shows the content that would go live. Shared skills follow the conversation's `ctx.conversation.space` on Slack, Discord, Teams, Telegram, and Chat SDK channels. Skills are stored in any `eve/memory/file` document backend, Vercel Blob by default, or in your own `SkillRepository` from `eve/extensions/custom-skills/repository`; `eve/extensions/custom-skills/policies` exports the built-in scopes and approval rule to compose your own.
