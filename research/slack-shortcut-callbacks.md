---
issue: https://github.com/vercel/eve/issues/2546
status: in-progress
last_updated: "2026-08-27"
---

# Slack shortcut callbacks

## Decision

Add an optional `onShortcut(shortcut, ctx)` callback to `slackChannel`. It handles
Slack message shortcuts (`message_action`) and global shortcuts (`shortcut`)
without expanding eve's generic interaction model.

The shortcut is a discriminated, eve-owned value. Both variants expose the
callback ID, trigger ID, invoking user, and workspace. Message shortcuts also
expose the selected channel and message. The context exposes only a
workspace-scoped Slack API handle because global shortcuts have no channel or
thread.

## Semantics

- eve verifies and acknowledges shortcut requests through the existing Slack
  interactivity route.
- eve acknowledges the request immediately and runs the callback under
  `waitUntil`.
- Callback errors are logged and do not alter the Slack response.
- A recognized shortcut without an authored callback is acknowledged and
  logged. Other unsupported interaction types are also acknowledged and logged
  with their type.
- Existing `block_actions`, `view_submission`, and HITL routing are unchanged.

## Validation

Unit tests cover both shortcut variants, normalization, workspace-scoped API
calls, immediate acknowledgement, and existing interaction behavior. Document
the hook on the Slack channel page and ship it as a patch release.
