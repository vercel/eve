# eve dev TUI parity: ownership checklist

## Why the gaps existed

- Model discovery treated the Gateway response as trusted display data and did
  not retain its release timestamp, so ordering could not express recency.
- `/model` owned only a model string rewrite. Reasoning and Gateway service tier
  already existed in the runtime contract, but the interactive flow had no
  atomic authored-source operation for them.
- Tool execution state and tool presentation were coupled to generic JSON
  summaries. That made a known operation such as `web_fetch` look like an
  unknown function call.
- The action adapter omitted `rejected` from its terminal outcomes, allowing a
  denial to reach the renderer through the success branch.
- stderr buffering was renderer-owned and transient. It could either overwhelm
  the transcript or be truncated with no durable local evidence.

## Contracts introduced in this tranche

- Catalog input is boundary-validated. Featured models remain a leading run;
  models within each tier sort by release date descending, then stable text
  keys, with undated entries last.
- The model menu drafts `model`, top-level `reasoning`, and Gateway
  `serviceTier` independently. Done performs one source transform and one
  atomic file replacement; Esc discards the draft.
- Missing reasoning means provider default and is not the same as authored
  `"none"`. Fast mode is the user-facing name for Gateway `"priority"`;
  Standard removes only that leaf. Unknown authored tiers are displayed and
  never overwritten by the menu.
- Tool calls remain independently keyed by call id. A pure presentation layer
  can name known tools without changing execution semantics. Rejected is an
  explicit terminal outcome, not a failed or successful alias.
- Long captured diagnostics go to a process-local `0600` file under a `0700`
  directory. Normal transcript mode shows a concise pointer; all-log mode can
  still reveal the captured stderr block.

## Deliberate boundaries

- This is a first parity tranche, not a parity claim. Same-status aggregation
  is presentation-only: a parallel cohort stays mutable until every call
  settles, then adjacent compatible blocks render as one group.
- Markdown is parser-backed and width-aware. Any future syntax support belongs
  in token rendering, not regexes over already-styled terminal text.
- Active-turn editing, steering, file attachments, session controls, and
  sandbox-readable host diagnostics require protocol or composition-root work;
  they do not belong in tool-label or model-menu code.

## Maintainer checks

- A new tool presenter must fall back safely when its input is malformed.
- Every protocol terminal status must map exhaustively to one renderer status.
- A source edit must bail before writing when an object path is dynamic,
  computed, spread-backed, or otherwise unsafe to preserve.
- A menu cancellation must leave authored source byte-for-byte unchanged.
- A diagnostic sink failure must not recurse through intercepted stderr.
