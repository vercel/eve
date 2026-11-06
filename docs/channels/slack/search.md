---
title: "Slack Search"
description: "Mount eve/extensions/slack-search so your agent can search public Slack channels, read channel history and threads, and look up users."
---

`eve/extensions/slack-search` lets your agent search and read **public** Slack channels. It ships inside the `eve` package, so you mount it without installing anything else. It never reads private channels or direct messages, and it never posts.

| Tool                | What it does                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `search`            | Searches public channels across the workspace with Slack's Real-time Search API, best match first        |
| `read_conversation` | Reads a channel's history or one thread, by channel name, ID, `<#C…>` mention, or permalink, with paging |
| `read_user`         | Looks up a user's name, title, and time zone by user ID                                                  |

The extension also adds instructions that tell the model to search early in the turn, scope single-day requests to that day, and cite the permalinks the tools return.

## Mount the extension

Create an extension file in an agent that has a [Slack channel](/docs/channels/slack). The file name sets the tool prefix, so this mount adds `slack__search`, `slack__read_conversation`, and `slack__read_user`:

```ts title="agent/extensions/slack.ts"
import slackSearch from "eve/extensions/slack-search";

export default slackSearch({});
```

`slackSearch({})` uses `SLACK_BOT_TOKEN`, as `slackChannel` does. With Vercel Connect, pass the same credentials as your channel:

```ts title="agent/extensions/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import slackSearch from "eve/extensions/slack-search";

export default slackSearch({
  credentials: connectSlackCredentials("slack/my-agent"),
});
```

To give a [subagent](/docs/subagents) the tools instead of the root agent, put the extension file in the subagent's `extensions/` directory.

## How search is authorized

Slack lets a bot token search only on behalf of someone who just messaged the bot. Each mention or DM carries a short-lived `action_token`, and `defaultSlackAuth` adds it to the turn's auth as the `action_token` attribute. The `search` tool reads it from there. If your channel's hooks build auth themselves, return `defaultSlackAuth` or keep the attribute; see [Slack's action token](/docs/channels/slack/reference#use-slacks-action-token).

So that:

- Search works only in a turn started by a Slack message. In other turns, such as schedules or HTTP sessions, it returns `reason: "no_slack_message"`, and the model reads specific channels with `read_conversation` instead.
- The token expires a few minutes after the message. Once it does, search returns `reason: "search_token_expired"` for the rest of the turn, and the model finishes from what it already found.
- `read_conversation` and `read_user` use the bot token alone, so they work in any turn. In a turn that didn't come from Slack, a function `botToken` receives no `teamId`, so an app installed in several workspaces must return a default workspace's token. `read_conversation` reads only channels the bot is a member of. For other channels it returns `reason: "not_in_channel"` and tells the model a channel member can invite the bot.

## Restrict what each caller sees

Without `authorize`, the tools follow the limits Slack's own search puts on people outside your workspace:

- Guests see nothing.
- In a Slack Connect conversation, or for a caller whose home workspace isn't the one the app is installed in, the tools return messages only from the conversation they asked in, and `read_user` is refused. The answer is posted where people from the other organization can read it.
- Everyone else in Slack sees every public channel the bot can read.
- Callers outside Slack, such as web sessions, see every public channel the bot can read. Set a policy if they shouldn't.

The extension reads who is asking with `users.info` and whether the conversation is shared with `conversations.info`, and caches both for a few minutes. If Slack can't answer, it treats the caller as external.

Set `authorize` to decide for yourself. It replaces the default and receives the same facts as `slack`. This policy keeps the default and also limits the agent to two channels:

```ts title="agent/extensions/slack.ts"
import slackSearch from "eve/extensions/slack-search";

const allowedChannels = new Set(["C0123ENG", "C0456LAUNCH"]);

export default slackSearch({
  authorize: ({ tool, channelId, slack }) => {
    if (!slack || slack.guest) return false;
    if (slack.sharedChannel || slack.external) {
      return tool !== "read_user" && channelId === slack.channelId;
    }
    return channelId === undefined || allowedChannels.has(channelId);
  },
});
```

`slack` is set when the caller asked in Slack: `channelId` is the conversation they asked in, `sharedChannel` says it's a Slack Connect conversation, `external` says the caller's home workspace is another one, and `guest` says they're a guest.

`authorize` runs once for each channel in a search result, before each channel read, and once for each `read_user` call, where `channelId` is absent. Return `false` to withhold it: search drops the match and reports how many it withheld, and reads and lookups return `reason: "not_authorized"`.

## Options

| Option        | Default                                                                              | Effect                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credentials` | `SLACK_BOT_TOKEN`                                                                    | The Slack channel's credentials, the same object `slackChannel` takes. Only `botToken` is used. A function `botToken` receives `{ teamId }` for the workspace the turn came from |
| `api`         | Slack's API                                                                          | Slack API transport overrides, the same as `slackChannel({ api })`                                                                                                               |
| `authorize`   | [Slack's limits for guests and other organizations](#restrict-what-each-caller-sees) | `({ tool, auth, channelId?, slack? }) => boolean`, called with the turn's caller                                                                                                 |

## Slack app scopes

Add these bot token scopes to your Slack app, then reinstall it:

- `search:read.public` for `search`
- `channels:read` and `channels:history` for `read_conversation`
- `users:read` for `read_user`, and to tell guests and people from other organizations apart
- `groups:read`, `im:read`, and `mpim:read` to check whether a private channel or DM the caller asked in is shared. eve's generated Slack app manifest already includes these

## Override a tool

Mount the extension from a directory, `agent/extensions/slack/extension.ts`, to replace or remove its tools beside the mount. This removes `read_user`:

```ts title="agent/extensions/slack/tools/read_user.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

To change a tool instead, import its definition from `eve/extensions/slack-search/tools` and define it again. The same import narrows its result with `toolResultFrom` in a hook. See [Override a contribution](/docs/extensions#override-a-contribution).

## What to read next

- [Slack](/docs/channels/slack): set up the Slack channel
- [Slack reference](/docs/channels/slack/reference): channel options, hooks, and auth
- [Extensions](/docs/extensions): mount, configure, and override extensions
