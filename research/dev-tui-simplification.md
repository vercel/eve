---
status: draft
last_updated: "2026-11-02"
---

# Simplifying the `eve dev` TUI

This plan rebuilds the `eve dev` terminal UI around a smaller state model. Identical behavior and
rendering are not goals; where a simpler model renders a little differently, the simpler model
wins. Paths are relative to `packages/eve/src/`.

## Summary

1. **One app state, a stack of input surfaces, and one view function (A).** Every input surface
   — the composer, approvals, questions, setup questions, pickers, and the trace viewer — becomes
   a surface on a stack. One `ask()` helper owns the key routing, teardown, and promise handling
   that today are written out by hand roughly 14 times.
2. **The composer is always open (B).** The runner stops opening and aborting the composer. It
   reacts to session snapshots by pushing surfaces on top of it. The draft never has to be saved
   and restored.
3. **One commit rule (C).** A block moves to scrollback once it and every block above it are
   final. Nothing is grouped across the commit boundary, and scrollback is never re-rendered.
4. **Logs arrive as structured events (D).** The dev server child sends typed log, rebuild, and
   sandbox events over its existing IPC channel. Nothing is scraped from text. Logs go straight to
   scrollback and never sit in the live region.
5. **Setup questions are surfaces (E2).** The setup panel stays inside the TUI but is built from
   A's surfaces and the shared `setup/cli/select-state` reducer.
6. **Fewer knobs (G subset).** `--verbose` replaces six display flags, and dead code goes.

Out of scope for this plan: moving setup out of the TUI into the CLI prompter (E1), moving or
removing `/traces` (F), the remaining niche-feature cuts from G, and adopting a TUI library (H).
The plan should not make any of those harder.

## Current state

There are about 20.8k lines of non-test code in `cli/dev/tui/`, plus about 2k in `cli/dev/`, and
about 11.9k lines of tests. That non-test code grew from 13.2k to 21.6k lines between four and
two months ago.

| Area                                                                                                                                                                                                             | Lines  | Touched by this plan    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------- |
| `terminal-renderer.ts`                                                                                                                                                                                           | 4,484  | A, B, C, D, E2          |
| Transcript: `transcript*.ts`, `blocks.ts`, `tool-*.ts`, `task-*.ts`, `file-content-cache.ts`, `line-diff.ts`, `conversation-view.ts`                                                                             | ~3,500 | C, G                    |
| Setup in the TUI: `setup-panel.ts`, `setup-commands.ts`, `tui-prompter.ts`, `setup-flow.ts`, `setup-selection-input.ts`, `provider-picker.ts`, `flow-drawer.ts`, `setup-issues.ts`, `registry-result-message.ts` | ~2,700 | E2                      |
| `traces/` and its helpers                                                                                                                                                                                        | ~2,500 | A (becomes one surface) |
| Input: `line-editor.ts`, `stream-format.ts`, both typeaheads, `prompt-commands.ts`, `prompt-command-handler.ts`, `question-panel.ts`, `message-queue.ts`, `prompt-placeholder.ts`                                | ~2,000 | A, B, G                 |
| `runner.ts`                                                                                                                                                                                                      | 1,808  | B                       |
| Status and chrome: status line, header, theme, Vercel and MCP status trackers, types                                                                                                                             | ~1,400 | B, D, G                 |
| Remote auth and connection                                                                                                                                                                                       | ~1,200 | No                      |

### Why it is big

1. **Every input surface manages keyboard ownership by hand.** `TerminalRenderer` has 101
   private fields, 108 `#paint()` calls, and 8 hand-written `new Promise` input readers. The
   composer, approval, question, help picker, info panel, seven setup readers, the startup draft,
   the setup flow's idle key trap, and the trace viewer each set `#consumeKey`, attach and detach
   input, store `#rejectActiveReader`, start or stop the caret, repaint, and clean up. On top of
   that are workarounds for handing keys from one surface to the next: `#keyBuffer` carry-over
   replayed in a `queueMicrotask`, `#flowIdleConsumer`, `#startupConsumer`, `#flowInterrupt`,
   `#transientPanelClose`, `#traceViewClose`, and `#armExitOnNextPrompt`.
2. **The runner opens and closes the composer.** `readInput` takes an `AbortSignal`, and the
   runner aborts it whenever something else needs the keyboard. The draft is therefore saved and
   restored through `#draft`, `#applyDraft`, `restoreDraft`, and a separate startup-draft path
   (`beginStartupDraft`, `finishStartupDraft`, `MessageQueue`).
3. **Deciding what moves into scrollback is complicated.** Blocks carry live and committed
   identity (`#committedIds`, `#blockById`, `#conversationBlockIds`). Tool groups are split by
   status, so a group's members are not contiguous and are removed by identity. Log coalescing
   has two modes (`"window"` and `"runs"`). Task end lines are positioned with placement anchors.
   And `/loglevel` re-renders past scrollback, which needs `#transcriptBlocks`,
   `#committedTranscriptRows`, `#rebuildCommittedTranscript`, `#replayTranscript`, and
   `logVisibility: "summary" | "all-only"`.
4. **Logs arrive through three paths, all parsed from text.** The parent's
   `process.stdout.write` is monkeypatched, and rebuild and sandbox lines are matched with
   regexes. The child writes records to stderr behind a `\u001eeve-console:` prefix. eve's own
   in-process log records come through a subscriber. Rebuild output then goes through an in-place
   "cycle" block, status-bar timers, and a stashed delayed build error.
5. **The renderer interface makes everything optional, but it has one implementation.**
   `AgentTUIRenderer` has about 30 optional methods. The runner calls them with `?.` 28 times and
   carries fallbacks for renderers that lack a method (for example `renderNotice` when
   `renderSessionBoundary` is missing, and `formatAgentUpdateNotice`).
6. **Six display flags multiply branches.** `--show-tools`, `--show-reasoning`,
   `--show-subagents`, `--show-connection-auth`, `--assistant-response-stats`, and
   `--context-size`. The first four take an enum of up to four values, and those enums are
   threaded through the renderer and transcript options.

## Target architecture

```
cli/dev/tui/
  terminal.ts        raw mode, bracketed paste, key decoding feed, LiveRegion, exit restore   ~300
  app.ts             AppState, surface stack, paint scheduling, footer layout                 ~700
  surface.ts         Surface interface and ask()                                              ~80
  surfaces/
    composer.ts      line editor, history, command and argument typeahead                    ~350
    approval.ts      approval and question surfaces                                           ~200
    select.ts        setup select, built on setup/cli/select-state                            ~350
    text.ts          setup text and masked input                                              ~100
    flow.ts          setup flow region (lines, status, output preview)                        ~250
    trace-viewer.ts  adapter over traces/TraceViewerSession                                   ~60
  transcript/        projection and block rendering                                           ~1,800
  logs.ts            LogEvent ingestion and level filter                                      ~150
  runner.ts          session loop, reacts to snapshots                                        ~900
```

### AppState and painting

`AppState` is one plain object: transcript blocks not yet committed, the surface stack, the
setup flow region (if any), status-line inputs, and the turn clock. Rendering is
`view(state, width, height) → { commit: string[]; live: string[] }`. Nothing else writes to the
terminal.

Paint scheduling uses one dirty flag flushed on `setImmediate`, plus one ticker that runs only
while something animates (a working turn, a running task, a setup status, or a focused text
field's caret). The caret blinks on the same ticker. This replaces the separate caret, tick,
log-level-hint, and dev-build-status timers and the `#painting` / `#paintAgain` reentrancy guard.

### Surfaces and `ask()`

```ts
interface Surface<T> {
  render(ctx: RenderContext): string[];
  onKey(key: TerminalKey, done: (value: T) => void, fail: (error: unknown) => void): void;
  /** Whether the caret ticker should run while this surface is on top. */
  animates?(): boolean;
  dispose?(): void;
}

function ask<T>(surface: Surface<T>): Promise<T>;
```

The top surface receives every key. `ask()` pushes a surface and pops it when `done` or `fail`
is called, so settling twice is impossible and teardown is uniform. When the TUI shuts down,
every surface on the stack is rejected with the interrupt error. A key chunk that spans a pop is
simply delivered to the new top surface. No carry-over buffer or microtask replay is needed,
because routing happens per key, not per attachment.

Ctrl+C and Escape semantics move into each surface's `onKey`. The only global keys are Ctrl+C
double-press-to-exit at the idle composer and Ctrl+L.

## A. Surfaces and a single view

- Split `terminal-renderer.ts` into `terminal.ts`, `app.ts`, `surface.ts`, and `surfaces/*`.
- Rewrite `readToolApproval`, `readInputQuestion`, `choosePromptCommand`, `showInfoPanel`, and the
  trace viewer as surfaces. Setup readers follow in E2.
- Delete `#consumeKey`, `#attachInput` / `#detachInput` juggling, `#rejectActiveReader`,
  `#transientPanel*`, `#hitlDrawer`, `#traceViewClose`, `#flowIdleConsumer`, and the
  `#keyBuffer` carry-over.
- `AgentTUIRenderer` loses its optional methods: the runner depends on the concrete renderer API.
  Tests use the real renderer over `test/mock-terminal.ts` rather than partial fakes.

Estimate: the renderer goes from 4.5k lines to about 1.4k across `terminal.ts`, `app.ts`,
`surface.ts`, and the non-setup surfaces. No visible behavior change is required.

## B. Always-open composer

- The composer is the bottom surface for the whole session, including boot. Messages submitted
  before the agent is ready queue in the runner. The startup draft, `beginStartupDraft`,
  `finishStartupDraft`, `MessageQueue`, and `message-queue.ts` go away. Their behavior becomes
  "the composer works from the first frame".
- The composer emits events (`submit`, `cancel`, `interrupt`) to the runner instead of resolving
  a per-read promise. `readInput`, its `AbortSignal`, `#inputController`, `#draft`, `#applyDraft`,
  and most of `restoreDraft` go away. Restoring a cancelled message becomes "set the composer
  text if it is empty".
- The runner loop becomes a reaction to store snapshots: open interactions push approval or
  question surfaces; a queued registry handoff pushes the setup flow once the session is idle; a
  failed session is replaced. The composer stays underneath throughout.
- The idle runtime-artifact poll (`#withIdleRefresh`) runs whenever no turn is working, not just
  while the composer promise is pending.
- Collapse the setup-attention, Vercel-status, MCP-status, and auth-probe refresh paths into one
  `refreshStatus()` with one revision counter, called at boot, after setup effects, and when
  runtime artifacts change.
- Remove the runner's fallbacks for missing renderer methods.

Estimate: the runner goes from 1.8k lines to about 900. Removing the optional renderer interface
saves another 150 to 200.

## C. One commit rule

- **Commit rule:** a block commits once it and every block above it are final. Committed blocks
  are written once and forgotten. Their ids are not retained, except for a set of committed
  conversation ids so a later snapshot cannot re-emit them.
- **`/loglevel` applies going forward.** Delete `#transcriptBlocks`, `#committedTranscriptRows`,
  `#rebuildCommittedTranscript`, `#replayTranscript`, `logVisibility`, and the `"runs"` coalescing
  mode. Hidden log lines are still in the diagnostics log file.
- **Logs never enter the block list** (see D). That removes log coalescing from
  `tool-block-groups.ts` entirely.
- **Tool grouping is contiguous only.** A run of consecutive calls to the same tool forms one
  group whose status is the worst member status. Drop status partitioning, so group members are
  always a contiguous slice and commit by prefix length.
- **Task lines are placed in turn order.** A task writes a start line at its call. Its end line is
  appended when it ends, as an ordinary block at the live edge. Drop `PlacedBlock`, placement
  anchors, and `#placeBlocks`.
- Drop the steering gutter's text matching (`#steeredMessages`); steered messages render as
  ordinary user messages.

Estimate: transcript, grouping, and blocks go from 3.5k lines to about 1.8k (before G), and about
400 lines leave the renderer.

## D. Structured log events

- Define one event type:

  ```ts
  type DevLogEvent =
    | { kind: "log"; source: "server" | "eve" | "stdout" | "stderr"; level: LogLevel; text: string }
    | {
        kind: "rebuild";
        phase: "building" | "complete" | "failed";
        summary: string;
        detail?: string;
      }
    | { kind: "sandbox"; level: LogLevel; text: string };
  ```

- The dev server child sends these over its IPC channel (`local-server-child.ts`,
  `console-records.ts`). The dev watcher emits rebuild events directly instead of printing lines
  for `parseDevRebuildLogLine` to scrape. Sandbox lifecycle messages are emitted as events at
  their source instead of matched by regex.
- The parent routes child stdout and stderr, IPC events, and in-process log records into one
  `logs.ts` sink. The sink appends everything to diagnostics and filters by level for display.
  Raw child output that is not an event becomes a `log` event with `source: "stdout" | "stderr"`.
- The parent keeps a thin `process.stdout` / `process.stderr` guard so a stray write cannot
  corrupt the frame. The guard only forwards to the sink; it does no parsing.
- Displayed logs commit directly to scrollback above the live region. They never sit in the live
  region and never interleave with block grouping.
- Rebuild state shows only in the status line. Delete the in-place rebuild cycle block
  (`#devRebuild`, `#devRebuildSequence`, `#settleDevRebuildStatus`) and the delayed dev build
  error stash. A failed rebuild commits one error block.
- Keep the long-diagnostic summary (`diagnostic-presentation.ts`): a long error collapses to a
  summary plus the diagnostics file path.

Estimate: about −600 to −900 lines across the renderer, `console-records.ts`,
`dev-rebuild-status.ts`, and the regex parsers.

## E2. Setup questions as surfaces

The `SetupFlowRenderer` interface in `setup-flow.ts` stays the boundary that `tui-prompter.ts`
and `setup-commands.ts` drive. Its implementation moves out of the renderer.

- **Flow region.** `begin`, `end`, `setStatus`, `renderLine`, `renderOutput`, `replaceContent`,
  and `setNavigation` update a `flow` field on `AppState`, rendered by `surfaces/flow.ts` in the
  footer. Output buffering for warning evidence stays, but as a plain capped array on that state.
- **Questions.** `readSelect`, `readEditableSelect`, `readProviderPicker`, `readText`,
  `readAcknowledge`, and `readChoice` each become `ask()` on a surface rendered inside the flow
  region. `select.ts` wraps `setup/cli/select-state` (`reduceSelect`) and supports an optional
  inline-editor row, which covers both the editable select and the provider picker's key row.
  The provider picker keeps its state machine in `provider-picker.ts`; only its key routing and
  caret handling move into the surface.
- **Interrupts.** `waitForInterrupt` becomes a surface with no rows that settles on Ctrl+C or
  Escape. It sits on the stack while the flow is working between questions, which replaces
  `#armFlowIdleTrap`, `#disarmFlowIdleTrap`, and `#flowInterrupt`.
- **Simplifications:**
  - Drop implicit flows: a question without `begin` is a programming error in the TUI.
  - Drop `hideLinesWhileQuestion` and `taskListLineStart` if the task-list layout can render its
    outcomes from `notices` alone; otherwise keep them as fields on the flow state.
  - Reduce `setup-panel.ts`, which is mostly rendering, by sharing option-row rendering with
    `setup/cli/option-row.ts` wherever the glyphs match.
- `withInheritedStdio` stays and becomes: pop everything to the composer, suspend `terminal.ts`,
  run the task, resume.

Estimate: setup in the TUI goes from about 2.7k lines plus about 1k inside the renderer to about
1.4k in total.

## G (subset). Fewer flags, no dead code

### `--verbose`

Replace `--show-tools`, `--show-reasoning`, `--show-subagents`, `--show-connection-auth`,
`--assistant-response-stats`, and `--context-size` with one boolean flag on both `eve dev` and
the remote TUI command.

| Setting         | Default                             | `--verbose`                           |
| --------------- | ----------------------------------- | ------------------------------------- |
| Tools           | Collapse when settled               | Full                                  |
| Reasoning       | Collapse when settled               | Full                                  |
| Subagents       | Start and end lines plus task panel | Also each child message and tool call |
| Connection auth | Full                                | Full                                  |
| Response stats  | Tokens per second                   | Tokens per second                     |
| Context fill    | Not shown                           | Not shown                             |

- `TerminalPartDisplayMode`, `SubagentDisplayMode`, and `AssistantResponseStatsMode` become one
  `verbose: boolean` on `TuiDisplayOptions` and `TranscriptOptions`. The `"hidden"` and
  `"collapsed"` (always collapsed) branches go away. Connection auth is always shown, because a
  hidden auth challenge looks like a hung turn.
- `--logs` stays: it is a filter, not a display mode.
- Update `cli/dev/command.ts` (`addTerminalDisplayOptions`), `cli/dev/command-options.ts`,
  `cli/dev/ui-options.ts`, `cli/run.test.ts`, `docs/guides/dev-tui.md`,
  `docs/reference/cli/index.md`, and add a changeset that names the removed flags. Removed flags
  fail with Commander's unknown-option error.
- Open question: whether to derive the context fill from model metadata instead of dropping it.
  This plan drops it.

### Dead code

- `stream-format.ts`: `parseKey`, `takeUntil`, the SGR mouse regex, and `formatContextPercentage`
  have no callers outside the file.
- Everything the workstreams above orphan: `message-queue.ts`, `dev-rebuild-status.ts`, `rail.ts` / `terminal-tool-part.ts` if unused afterwards, and
  the unused `AgentTUI*` types.
- Run `knip` or an equivalent unused-export check once the stack lands.

Estimate: about −300 to −500 lines, plus mode branching removed from the transcript.

## Accepted behavior changes

- `/loglevel` and Ctrl+L affect only output that arrives afterwards.
- Logs never appear in the live region. A log line printed during a streaming turn commits above
  the live region immediately.
- No in-place rebuild line in the transcript. Rebuild progress lives in the status line, and a
  failure commits one error block.
- Tool groups merge only consecutive calls to the same tool. Mixed outcomes show one group with
  the worst status.
- A task's end line appears where the transcript was when the task ended.
- Steered messages look like ordinary user messages.
- The composer accepts input from the first frame. Messages sent before the agent is ready queue
  invisibly instead of in a separate panel.
- Six display flags become `--verbose`. Context fill and the tokens-only stats mode are gone.

## Sequencing

Each step is one or two PRs and leaves `eve dev` working.

1. **G: flags and dead code.** Cheap and independent. This removes mode branching before the
   transcript is touched.
2. **A, part 1: `terminal.ts`, `surface.ts`, `ask()`, and the paint scheduler.** Move the
   approval, question, help picker, info panel, and trace viewer onto surfaces. Setup readers
   still use the old path.
3. **E2: setup flow region and setup surfaces.** Delete the renderer's setup section and the idle
   trap.
4. **B: always-open composer and the snapshot-driven runner.** Delete `readInput`, the startup
   draft, and the optional renderer interface.
5. **D: structured log events.** Child IPC events, `logs.ts`, and the stdout guard. Delete the
   regex parsers and the rebuild cycle.
6. **C: commit rule.** Contiguous tool groups, task lines in turn order, no scrollback replay.
7. **Cleanup.** Unused-export pass, test consolidation, docs.

Steps 2 and 3 must land in that order; step 4 depends on step 2. Steps 5 and 6 depend only on
step 2 and can land in either order.

## Testing

- Behavior tests drive the real renderer through `test/mock-terminal.ts` and
  `test/fake-eve-server.ts`, asserting on the final screen and scrollback. Unit tests remain for
  pure reducers: the line editor, `select-state`, the provider picker, transcript projection, and
  markdown.
- Delete tests that pin removed behavior: scrollback replay, log coalescing modes, placement
  anchors, the rebuild cycle, display-mode matrices, and the startup queue panel.
- Keep the channel conformance driver (`internal/testing/channel-conformance/tui-driver.ts`)
  green at every step. It is the end-to-end check that the TUI still talks to a server correctly.
- Expected test size: about 11.9k lines down to 6k to 7k.

## Estimates

| Area                                                                     | Today      | After      |
| ------------------------------------------------------------------------ | ---------- | ---------- |
| Renderer excluding its setup section (terminal, app, non-setup surfaces) | ~3,500     | ~1,400     |
| Runner                                                                   | 1,808      | ~900       |
| Transcript                                                               | ~3,500     | ~1,700     |
| Setup in the TUI (including the renderer's share)                        | ~3,700     | ~1,400     |
| Input                                                                    | ~2,000     | ~1,500     |
| Status and chrome                                                        | ~1,400     | ~1,000     |
| Markdown, traces, remote, test helpers                                   | ~4,800     | ~4,800     |
| **Total non-test**                                                       | **~20.8k** | **~12.7k** |

The parts this plan touches go from about 16k lines to about 8k. Traces and remote auth are
unchanged and account for most of what remains. Structural measures matter more than line
counts:

- Renderer state: from 101 private fields to an `AppState` with about 25 fields.
- Keyboard ownership: from about 14 hand-written modes to one stack.
- Log ingestion: from 3 text-parsed paths to 1 typed sink.
- Commit bookkeeping: from 5 collections plus a replay path to 1 set of committed ids.
- Paint timers: the caret, ticker, log-level hint, and dev-build status timers become 1 ticker.

## Risks and open questions

- **Rendering parity during the stack.** Steps 2 to 4 run old and new paths side by side. Keep
  the footer layout in one function from step 2 onward so both paths share it.
- **Bracketed paste and Escape timing.** Key decoding (`nextKey`, the 30 ms Escape flush, the
  incomplete-paste flush) moves unchanged into `terminal.ts`. Do not rewrite it in the same PR.
- **Setup flows not covered by tests.** E2 touches every setup command. Before step 3, inventory
  which `SetupFlowRenderer` features each command uses (`navigation`, `searchAction.load`,
  `readChoice`, `replaceContent`) and add a scenario test for each that lacks one.
- **Dev watcher rebuild events.** D needs the dev watcher to emit typed events over IPC. Check
  that worker threads in the child can reach the IPC channel, or relay through the child's main
  thread as `console-records.ts` does today.
- **Context fill.** Decide whether the model metadata in `/info` can supply the context window,
  which would let the end-of-turn line keep a context percentage without a flag.
