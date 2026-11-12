---
"eve": minor
---

Add `ctx.conversation.space`, which names the place a conversation happens, such as a Slack channel, so tools, approval policies, dynamic values, and memory scopes can share data per place.

Slack, Discord, Teams, Telegram, Linq, Photon, and Chat SDK channels report a space with a stable `id` namespaced by platform and workspace, a `type` of `direct`, `group`, or `channel`, a `visibility` of `public` or `private` when the platform says, and a `workspaceId` where the platform has one. Custom channels report theirs with a new `space({ state })` hook beside `audience`. Tools and memory scope resolvers can now read `ctx.conversation`, which dynamic values already had.
