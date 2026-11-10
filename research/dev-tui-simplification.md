---
issue: https://github.com/vercel/eve/pull/5826
status: implemented
last_updated: "2026-11-02"
---

# Simplifying the `eve dev` TUI

This plan rebuilds the `eve dev` terminal UI around a smaller state model. Identical behavior and
rendering were not goals; where a simpler model renders a little differently, the simpler model
won. Paths are relative to `packages/eve/src/cli/dev/tui/`.

## Summary

1. **One stack of input surfaces on top of an always-open composer.** Approvals, questions, setup
   questions, `/help`, `/info`, the trace viewer, and the setup flow's interrupt trap are
   surfaces. One `ask()` helper owns key routing, settling, and teardown, which used to be
   written out by hand about 14 times.
2. **The composer never closes.** The runner reads actions from a queue with
   `nextInput(signal)`; aborting the read no longer closes the composer, so no draft is saved and
   restored. Messages sent while the agent starts wait in the queue.
3. **One commit rule.** A block moves to scrollback once it and every block above it are final.
   Tool calls group only in contiguous runs, task end lines append at the live edge, and
   scrollback is never re-rendered.
4. **One log sink.** Foreign writes, console records, and eve's own log records reach one
   ingestion function that filters once and writes straight to scrollback. Rebuild progress
   drives the status line.
5. **Setup questions are surfaces.** The setup flow is its own module on the same stack.
6. **Fewer knobs.** `--verbose` replaces six display flags; dead code is gone.

## Architecture

```
terminal.ts          raw mode, bracketed paste, key decoding, live region, output capture
surface.ts           Surface, Settle, ask()
terminal-renderer.ts state, surface stack, transcript commit, footer, drawers, trace viewer
composer.ts          the always-open editor: history, typeahead, Enter/Esc/Ctrl+C grammar
setup-flow-view.ts   the setup flow drawer and its question surfaces
logs.ts              captured output → transcript blocks and build phase
runner.ts            session loop over nextInput(), interactions, commands, setup
```

The top surface gets every key. `drawer` surfaces replace the composer and keep the task panel
above them, `panel` surfaces replace the footer, `flow` surfaces paint inside the open setup
flow, and key traps paint nothing. When the TUI closes, every surface settles: drawers reject as
interrupted, setup questions resolve as cancelled, and the interrupt trap fires `ctrl-c`.

One ticker drives every animation. It runs every 90 ms while something moves (a turn, a task,
a setup flow, a pending command, a rebuild status, a catalog load) and every 500 ms when only a
caret blinks. Paints stay synchronous so a key's effect is on screen when the key handler
returns; a paint that would draw an identical frame is skipped.

## Behavior changes

- `--show-tools`, `--show-reasoning`, `--show-subagents`, `--show-connection-auth`,
  `--assistant-response-stats`, and `--context-size` are replaced by `--verbose`. Sign-ins always
  show. The tokens-per-second meta row and the context-fill percentage are gone.
- `/loglevel` and `Ctrl+L` apply to output from then on. Every line still reaches the
  diagnostics log.
- Logs print as they arrive, above anything still streaming, instead of waiting in the live
  region and coalescing.
- Rebuilds show in the status line; a failed rebuild commits one error line at once.
- Consecutive calls to the same tool share one row whatever their outcomes; a run with failures
  lists each call with its failure summary.
- A task's end line appears where the transcript was when the task ended.
- Steered messages look like ordinary user messages.
- The composer works from the first frame. Messages sent while the agent starts show as dim
  `Queued:` rows and send once it is ready.
- A setup question must be asked inside an open flow.

## Decisions

- **Logs keep the stderr record channel.** The plan proposed IPC events from the dev server
  child, but worker threads in the child cannot reach the IPC channel, so the
  `console-records.ts` transport stays. The rebuild line grammar still lives in one module,
  `dev-watcher-log.ts`, which formats and parses it.
- **The Vercel and MCP status trackers stay separate.** Only the setup-attention and Vercel
  login probes merged into one refresh with one revision counter.

## Outcome

| Area                                      | Before |  After |
| ----------------------------------------- | -----: | -----: |
| Renderer, terminal, composer, logs        |  4,484 |  2,439 |
| Runner                                    |  1,808 |  1,528 |
| Transcript and blocks                     |  3,497 |  3,238 |
| Setup in the TUI (now with the flow view) |  2,718 |  3,533 |
| Input                                     |  2,011 |  1,833 |
| Status and chrome                         |  1,069 |    954 |
| **All non-test code in `tui/`**           | 20,070 | 18,002 |

The line count fell about 10%, far less than the plan's estimate: most of the renderer was real
interaction and layout code, not lifecycle scaffolding, and it moved rather than disappeared.
The structural measures moved more:

- Renderer state: from 104 private fields to 52, with the setup flow's state in its own module.
- Keyboard ownership: from about 14 hand-written modes to one stack.
- Log ingestion: from three text-parsed paths with an in-place rebuild block and a delayed-error
  stash to one sink.
- Commit bookkeeping: from five collections and a replay path to two id sets.
- Timers: the caret, ticker, log-level hint, dev-build status, and catalog-loading timers became
  one ticker.
