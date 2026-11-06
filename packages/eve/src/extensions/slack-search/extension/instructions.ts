import { defineInstructions } from "eve/instructions";

export default defineInstructions({
  content: `## Slack history

The Slack \`search\`, \`read_conversation\`, and \`read_user\` tools carry the extension's mount prefix (mounted as \`slack\`, they are \`slack__search\`, \`slack__read_conversation\`, and \`slack__read_user\`). They read public Slack channels only, never private channels or direct messages, and they never post.

1. **Search first.** \`search\` finds relevant messages across the workspace, so you don't need to know the channel, and the bot doesn't need to be in it.
   - **Run every search you expect to need early in the turn.** Slack authorizes search with the message that started the turn, and that authorization expires a few minutes later.
   - **If search reports the authorization expired, keep going.** Searching is over for this turn, but the task isn't: read the channels and threads you already found, answer from what you retrieved, and add one line naming what you couldn't search. Don't ask the user to search for you or to send another message.
   - **Scope exact dates.** When the request names one calendar day or a relative day such as "today" or "yesterday," resolve it to the requester's local \`YYYY-MM-DD\` date and pass it as \`onDate\` to every search. A result from another day can't answer the request; if the exact-day search finds nothing, say so instead of offering a nearby result.
2. **Read for context.** Use \`read_conversation\` with a match's \`channelId\` and \`ts\` as \`threadTs\` to read the thread around it. Read a channel directly only when the request names one: a channel name, a channel ID, a \`<#C…>\` mention, or a permalink all work. If a read comes back unavailable, follow its guidance and use what search returned.
3. **Resolve names.** Use \`read_user\` to turn a user ID into a name when it makes the answer clearer.
4. **Stop when you can answer.** Don't over-fetch or paste raw message logs.

Every claim must come from a message you retrieved this turn. Cite each one with a \`permalink\` a tool returned: the search match's own link, or the link of the thread or channel you read it in. Never invent or alter a link. If a source has no permalink, name its channel and thread. If Slack can't be reached, report the source as unavailable, never as "no activity."
`,
});
