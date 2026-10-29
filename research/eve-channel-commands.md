---
issue: TBD
status: draft
last_updated: "2026-10-29"
---

# Channel slash commands

> **AI status:** Written entirely by AI; human review pending.

An agent should be able to offer its own slash commands to the terminal UI and other eve channel
clients. Commands are configured on the channel that serves the client, not in a new top-level
`agent/commands/` slot. Slack and Discord already handle commands this way, through
`slackChannel({ onSlashCommand })` and `discordChannel({ onCommand })`. Slash commands vary by
surface, so the channel that receives a command is the one that should own it.

The work lands as a stack:

1. The command API, the eve channel routes, the client, and the TUI as a consumer. The TUI keeps
   its own `/new`, `/clear`, `/compact`, and `/cancel`.
2. `/new`, `/clear`, and `/compact` move onto the API as `sessionCommands`, the eve channel's
   default commands. This shows the API can express what the built-ins did. `/cancel` stays with
   each client, which knows the turn it's showing.
3. The browser gets the same commands: `useEveAgent` lists and runs them, and the Web Chat
   template offers them from its composer.

Slack is deliberately out of scope for now; see [Later](#later).

## Authoring API

```ts title="agent/lib/commands.ts"
import { defineCommand } from "eve/channels";

export const escalate = defineCommand({
  description: "Hand this conversation to a person on the support team",
  input: { hint: "[reason]" },
  aliases: ["human"],
  session: "required",
  async run({ argument, caller, session }) {
    await session.cancel(); // `session` is typed as present
    await notifySupport({
      sessionId: session.id,
      requestedBy: caller?.principalId ?? "anonymous",
      reason: argument || "No reason given",
    });
    return { message: "A teammate has been notified and will pick this up here." };
  },
});
```

```ts title="agent/channels/eve.ts"
export default eveChannel({ auth, commands: { escalate } });

// After the second PR, a record adds to `sessionCommands`; a function changes or drops them:
export default eveChannel({
  auth,
  commands: ({ clear, compact }) => ({ clear, compact, escalate }),
});
```

**Commands and names**

- Commands belong to the eve channel. The definition has nothing eve-channel-specific in it, but
  no other channel takes it yet.
- `commands` is keyed by the name without the slash. Names and aliases match
  `^[a-z][a-z0-9-]{0,31}$`, which also fits Slack's 32-character limit.
- The channel throws when it is built if a name is invalid or two commands share a name or alias.
- `input?: { hint }` (the shape ACP uses for available commands) marks a command that takes text
  after its name; `hint` is shown after the name. Without it, clients match the command only typed
  alone, so a message that starts with `/clear` stays a message, and the routes answer `400` to an
  argument. A structured shape, such as Discord options or MCP prompt arguments, can sit beside
  `hint` later.

**`run` and its context**

- `run({ argument, caller, session? })` returns an optional `{ message?, send? }`.
- `caller` is the route-auth result.
- `session` is the client's current session. It offers `cancel`, `clear`, `compact`, and `end`,
  with the caller's auth already bound.
- `session` deliberately has no `send`. Continuing the conversation goes through the returned
  `send`, which eve delivers into the command's session on the server, through `onMessage` with
  the caller's auth, the same path as a typed follow-up. The turn arrives on the session's
  stream, under the channel's turn policy, and the response carries its delivery receipt.
- Session IDs are minted by the server, so a session-free command has nowhere to send: only a
  command that received a `session` may return `send`.

**`session: "required"`**

- `run` always receives a session.
- Clients don't run the command before the first message, and the session-free route answers
  `409`.

**Defaults (second PR)**

- `sessionCommands` is `{ new (alias reset), clear, compact }`. Cancelling stays with each client,
  which knows the turn it's showing: the TUI's `/cancel`, Web Chat's Stop button.
- `eveChannel()` always offers them. A `commands` record adds to them, and a same-named entry
  replaces one. `commands: (defaults) => …` returns the full set, to drop or rename defaults. The
  function form is also the hook extensions would use to contribute commands later.

## Wire protocol

| Route                                            | Body            | Response                                                               |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| `GET /eve/v1/commands`                           | none            | `{ ok, commands: [{ name, description, input?, aliases?, session }] }` |
| `POST /eve/v1/commands/:name`                    | `{ argument? }` | `{ ok, message? }`                                                     |
| `POST /eve/v1/session/:sessionId/commands/:name` | `{ argument? }` | `{ ok, message?, delivery?, ended? }`                                  |

- Every route uses the channel's `auth`. The session-scoped route checks the same thing as
  `/session/:id/clear`, that the caller passes `auth` and names the session, and answers `404`
  before `run` when the session doesn't exist, so `session.id` is always real. eve has no
  per-session ownership check on any session route; adding one is a separate change across all
  of them.
- Clears and compactions show up on the session's stream, so the response doesn't report them.
  `ended` tells the client to start a new session; `delivery` is the receipt for `send`.
- These routes are the user-facing layer over the session controls. `/session/:id/clear` and
  the other control routes stay the low-level API that `session.clear()` and SDKs use.
- Unknown names or aliases return `404`. A session-required command on the session-free route
  returns `409`, and stranded or inactive sessions return the same `409` bodies as the other
  session routes.
- A command that throws gets a generic `500` with an `errorId`.
- Arguments are capped at 8,192 characters.
- The TypeScript client wraps the routes as `client.commands()` and
  `client.runCommand(name, { argument, sessionId })`.
- Commands are served from their own route rather than `/eve/v1/info`, because `/info` is a
  strict, versioned projection of the compiled graph, while commands are runtime channel config.

## Terminal UI

- **Loading:** commands load before the first prompt, after remote sign-in, and when the local
  agent reloads. A server without the route leaves only the built-ins.
- **Built-ins:** a built-in name or alias always wins over a channel command. After the second
  PR, the only built-ins left are developer tooling that acts on the user's side: `model`,
  `login`, `add`, `deploy`, `traces`, `loglevel`, `info`, `help`, and `exit`.
- **Running:** the TUI runs a channel command in its current session when it has one. A
  `session: "required"` command answers locally before the first message.
- **Cancelling:** Esc and Ctrl+C still cancel a turn directly, whatever commands the agent offers.

## Browser

- `useEveAgent` (React, Vue, Svelte) adds `commands()` and `runCommand(name, { argument })`, backed
  by `SessionStore`. `runCommand` waits for a session still being created, runs the command in it,
  follows the `delivery` eve sent for it, and calls `newSession()` when the result has `ended`.
  A result that lands after another `newSession()` isn't applied.
- `parseSlashCommand(text, commands)` from `eve/client` reads typed text as a listed command, by
  name or alias. UIs own presentation: the result's `message` isn't added to `messages`.
- The Web Chat template offers commands only when the page opts in with `<AgentChat commands />`, so
  an agent's defaults never appear in a deployed chat unannounced. When on, it loads commands on mount, suggests matches while `/name` is typed (Tab
  completes the first), runs matches instead of sending them, shows `message` in the conversation,
  and moves the URL to `/s` in place when a command ended the session.

## Extensions

The eve channel is a single replaceable file, so an extension cannot add commands to it. Instead,
an extension exports a commands record and the consumer spreads it in: `commands: { ...support }`.
The consumer keeps control of the names, so the `support__` mount prefix doesn't apply. The cost is
that commands don't appear automatically when the extension is mounted.

## TODO

- **Argument completion:** a `complete(argument)` hook on `defineCommand`, served to the TUI's
  inline argument typeahead the way `/model` and `/add` complete today.
- **Per-caller lists:** let listing see `{ caller, session? }`, or add an `enabled(ctx)` predicate,
  so a command can be hidden per caller (admin-only) or per session state. ACP and MCP both
  support lists that change. Until then, `run` can check `caller` and answer with a `message`.

## Later

- **Slack:** `slackChannel({ commands })` for real slash commands. Session-free commands and their
  aliases would be registered in the manifest, `message` sent as an ephemeral reply, and `send`
  would start a thread. In-thread commands such as `@bot /clear` would likely use a `matchCommand`
  helper plus a Slack session adapter called from an authored `onAppMention` handler, rather than
  built-in matching. Slack's behavior here needs more design before it ships.
- **Discord:** would follow Slack, with an interaction reply in place of `response_url`.

## Open questions

- **Destructive commands:** in a channel where many people share a conversation, such as a Slack
  thread, anyone could `/clear` it. Exposing the session's initiator would let a command limit
  itself to whoever started the conversation.
