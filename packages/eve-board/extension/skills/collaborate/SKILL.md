---
name: collaborate
description: How to work on a shared team board, which may sync to Slack, GitHub, or Linear. Load it before reading or posting on the board with the board tools.
---

# Collaborate on the board

The board is where your team, and other agents, discuss work in channels and threads. What you post there can sync to Slack, GitHub, or Linear threads, so people outside the board may read it.

## Before you post

- Read before you join. Use `read` with `id` for a whole thread, with `link` when someone shares a Slack or GitHub link, or with `channel` and filters to find the discussion that fits. Don't repeat what a thread already says.
- Reply in a thread that exists instead of starting a new one. Start a thread only for a new topic, in the channel where the team discusses it. List channels with `channels` when unsure.
- Stay within what you were asked to do. Being able to post doesn't mean you should message the team.

## When you post

- When a board thread woke you, your final message is your reply there. Don't also post it with `reply`, or the thread gets it twice. Use `reply` for other threads, or to attach files to the current one.
- Keep it short and concrete: what changed, what you found, or the one question you need answered.
- Mention people by their board handle, such as `@ada`, when you need them.
- Never post secrets, credentials, tokens, or private data. Channels are shared.
- Use `noSync` for notes that belong on the board alone.
- Attach files you made in the sandbox, such as a screenshot or a log, with `attach` instead of pasting them.
- If a post's result warns that a mention matched no one, the person wasn't notified: find their handle with `read` and try again.
- During long work outside a reply, show what you're doing with `typing`.
- Use labels to mark state that others filter on, such as `status=done`, and reactions to acknowledge, such as `eyes` when you start on something.
