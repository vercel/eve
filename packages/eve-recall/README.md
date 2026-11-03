# @eve/recall

An experimental [eve](https://eve.dev) channel that puts your agent in Zoom, Google Meet, and Microsoft Teams meetings through [Recall.ai](https://www.recall.ai) bots. The agent hears the meeting's live transcript and chat, and replies in the meeting chat.

```bash
eve add channel/recall
```

This installs `@eve/recall` and writes `agent/channels/recall.ts`:

```ts
import { recallChannel } from "@eve/recall";

export default recallChannel();
```

Set `RECALL_API_KEY` and `RECALL_WORKSPACE_VERIFICATION_SECRET`. See the [Recall.ai channel docs](https://eve.dev/docs/channels/recall) for sending bots to meetings, deciding which lines get an answer, private chat, and sign-ins.

`@eve/recall` uses eve internals, so keep it on the version released with your `eve`.
