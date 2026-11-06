---
"eve": minor
---

Add a `userAuth` option to `eve/extensions/slack-search`, so people can search Slack and read public channels the bot isn't in with their own Slack sign-in.

Pass a user sign-in such as `connect("slack/my-agent")` from `@vercel/connect/eve`. eve asks the person to sign in the first time, and the tools use their token when the turn has no Slack action token, when it expires, or when the bot isn't in a channel.
