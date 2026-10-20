---
issue: https://github.com/vercel/eve/pull/5061
status: implemented
last_updated: "2026-10-20"
---

# Session usage renewal across the delegation tree

With `limits.sessionUsage`, each session in a delegation tree checks its own
usage window. An Approve on one session's prompt started a new window only in
that session. A root that fanned out to two workers past the limit asked four
times for one overrun: once in the worker that crossed the limit, then in the
parent when that worker's reply landed, and again for each sibling still
spending in its old window.

## Renewal

One approved prompt now starts a new window in every session of the tree.

- Up: the approval travels to the root through the routing sessions that relay
  the prompt. Each one renews its own window when it delivers a non-cancel
  response.
- Down: each session that renews sends a `renew-window` payload to its started
  task runs and workflow tool runs. Each child applies it before its next
  budget check, or at once when it is parked, and sends it on to its own
  children.

Each renewal carries the id of the approved request. A session keeps the last
16 ids and ignores a repeat, so a renewal that reaches a session by two paths
starts one window, not two.

## Spend by window

A child's spend reaches its parent only when the child replies, and a renewal
travels the other way, so a report and a renewal can cross. Every usage report
therefore names the window each part was spent in, as `windows` beside `usage`:
a map from the renewal id that started the window to the spend in it, with `""`
for a session's first window. A run sums its sessions' reports per window, and
a session that opened before a renewal reached it spends in the run's window at
the time it opened.

The receiving session adds all of it to its totals. The part spent in its
current window counts there. The part spent in an earlier window moves its
window start, so it stays out. The part spent in a window it hasn't started
yet, from a renewal a descendant applied first, stays out too and counts once
the session applies that renewal. Arrival order no longer matters.

A task run that starts after a renewal the session already applied gets that
renewal when it reports started, since renewals skip runs that haven't.

A missed renewal would leave later spend tagged with the old window, so
delivery doesn't drop one. A blocking run that hasn't registered its control
hook yet is waited for, as an interrupt is, and the renewing step fails and
retries if it never does. A child session that hasn't claimed its inbox yet
is waited for the same way. A run's renewal covers the sessions it opened and
those still opening, and its messages wait for the renewal. A renewal that
still can't reach a live session after the step's retries fails the run,
which ends its sessions: the run may be waiting on that session's result and
never send it another message.

## Gaps

- A model call already in flight when the renewal arrives counts in the new
  window. That is at most one call per child.
- Remote agents keep their own windows. The renewal goes only to sessions in
  this deployment.
- Parallel children can still spend about N times the limit before the parent's
  next check. A tree-wide check is still a follow-up.

## Compatibility

`windows` is a new optional field on subagent results, so the extension
capabilities that see those results bump one epoch and keep the previous one.
A reply from an older deployment has no `windows`, so the parent counts all of
it in the current window, as before.
