---
"eve": minor
---

Add the `eve/extensions/slack-search` extension, which lets an agent search public Slack channels, read channel history and threads, and look up users.

Mount it with `slackSearch({})` from `agent/extensions/slack.ts` to get `slack__search`, `slack__read_conversation`, and `slack__read_user`. Search uses the `action_token` that `defaultSlackAuth` adds to the turn's auth, and an optional `authorize` policy decides which channels each caller may see. By default, guests see nothing, and callers in a Slack Connect conversation or from another workspace see only the conversation they asked in.
