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
2. Those four controls move onto the API as `sessionCommands`, the eve channel's default
   commands. This shows the API can express what the built-ins did.

Slack is deliberately out of scope for now; see [Later](#later).

## Authoring API

```ts title="agent/lib/commands.ts"
import { defineCommand } from "eve/channels";

export const triage = defineCommand({
  description: "Triage open issues",
  argumentHint: "[label]",
  aliases: ["t"],
  run({ argument, caller, session }) {
    return { message: "Triage queued", send: `Triage the issues labeled ${argument}.` };
  },
});

export const clear = defineCommand({
  description: "Clear the session context and keep the session",
  session: "required",
  async run({ session }) {
    await session.clear(); // `session` is typed as present
    return { message: "Clearing the session context." };
  },
});
```

```ts title="agent/channels/eve.ts"
export default eveChannel({ auth, commands: { triage, clear } });

// After the second PR, omitting `commands` offers `sessionCommands`:
export default eveChannel({ auth, commands: { ...sessionCommands, triage } });
```

**Commands and names**

- A command definition doesn't depend on any one channel, so other channels can offer the same
  definitions later.
- `commands` is keyed by the name without the slash. Names and aliases match
  `^[a-z][a-z0-9-]{0,31}$`, which also fits Slack's 32-character limit.
- The channel throws when it is built if a name is invalid or two commands share a name or alias.

**`run` and its context**

- `run({ argument, caller, session? })` returns an optional `{ message?, send? }`.
- `caller` is the route-auth result.
- `session` is the client's current session. It offers `cancel`, `clear`, `compact`, and `end`,
  with the caller's auth already bound.
- `session` deliberately has no `send`. Continuing the conversation goes through the returned
  `send`, which the client submits as the caller's own message, so `onMessage` and session auth
  apply to it as they do to typed input.

**`session: "required"`**

- `run` always receives a session.
- Clients don't run the command before the first message, and the session-free route answers
  `409`.

**Defaults (second PR)**

- `sessionCommands` is `{ new (alias reset), clear, compact, cancel }`.
- `eveChannel()` offers them when `commands` is omitted. Passing `commands` replaces them.

## Wire protocol

| Route                                            | Body            | Response                                                                      |
| ------------------------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| `GET /eve/v1/commands`                           | none            | `{ ok, commands: [{ name, description, argumentHint?, aliases?, session }] }` |
| `POST /eve/v1/commands/:name`                    | `{ argument? }` | `{ ok, message?, send?, controls? }`                                          |
| `POST /eve/v1/session/:sessionId/commands/:name` | `{ argument? }` | `{ ok, message?, send?, controls? }`                                          |

- Every route uses the channel's `auth`. The session-scoped route checks the same thing as
  `/session/:id/clear`: the caller passes `auth` and names the session.
- `controls` lists the session controls the command applied, so a client can mirror them. For
  example, the TUI resets its view after `end` and shows a pending cancel after `cancel`.
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

## Extensions

The eve channel is a single replaceable file, so an extension cannot add commands to it. Instead,
an extension exports a commands record and the consumer spreads it in: `commands: { ...crm }`.
The consumer keeps control of the names, so the `crm__` mount prefix doesn't apply. The cost is
that commands don't appear automatically when the extension is mounted.

## TODO

- **Argument completion:** a `complete(argument)` hook on `defineCommand`, served to the TUI's
  inline argument typeahead the way `/model` and `/add` complete today.

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
