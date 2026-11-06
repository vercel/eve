---
issue: "#623"
status: in-progress
last_updated: "2026-10-01"
---

# Channel event composition

## Summary

Built-in channels merged `config.events` over their defaults, so a handler for one event replaced the channel's handler for it. A GitHub `turn.started` handler that only posted status silently dropped the repository checkout; the same applied to reply delivery (`content.completed`) and failure comments (`turn.settled`, `session.ended`).

Separately, one app has one GitHub channel, but several extensions need its webhooks (`pull_request`, `issues`, CI events, comments). Today the app chains their hooks by hand.

## Authoring API

`eve/channels` exports three wrappers for a built-in channel's `events` entries:

- `beforeDefault(handler)`: runs before the default.
- `afterDefault(handler)`: runs after the default.
- `replaceDefault(handler)`: runs instead of the default.

An entry is one wrapper or a list of them, with at most one `replaceDefault`. The default (or replacement) runs exactly once. A `before` or `after` handler that throws is logged and the rest still run, matching hook failure isolation (#3684). A failure of the default or a replacement propagates as before. A plain function keeps today's replacement behavior and logs a warning when it replaces a default, so the change is not breaking; a later major can reject it.

`eve/channels/github` exports `defineGitHubHandlers({ name, onComment?, onIssue?, onPullRequest?, onCheckRun?, onCheckSuite?, onWorkflowRun? })`. `githubChannel({ handlers: [...] })` runs, per webhook, the config's own hook (for comments, `onComment` or the default invocation-token gate) and then each contribution in list order. Every handler sees the event; a throw is logged and skipped; the first non-null result dispatches the one turn and later results are logged and dropped.

## Scope

- Applies to GitHub, Linear, Discord, Teams, Telegram, Twilio, and Chat SDK channels (and Linq and Photon, which pass through to Chat SDK). Slack already composes rendering through `renderers` with `next`.
- Contributions are explicit values the app lists. Extensions have no build-time slot that adds to another channel's inbound hooks; a file-based slot (like `hooks/`) is a possible follow-up.
