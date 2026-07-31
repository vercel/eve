---
issue: https://github.com/vercel/eve/issues/1226
status: proposed
last_updated: "2026-07-31"
---

# linearChannel: exclude other agents' threads from the dispatched turn

Linear's `AgentSessionEvent` webhook ships a `promptContext` string
containing the `<primary-directive-thread>` where the agent was mentioned
_and_ every `<other-thread comment-id="…">` block on the issue — including
threads belonging to other agents' sessions. `linearChannel` uses
`promptContext` verbatim as the turn message and unconditionally spreads
`event.previousComments` into the dispatched context. When several agents
work on one issue, each new session starts with the other agents' full
conversations in its model-visible context: a cross-agent context leak and
a prompt-injection surface, with no supported way to filter it.

## Authoring API

Two complementary surfaces: a config flag for the common case, and hook
overrides as the general escape hatch. An explicit hook override always
wins over the flag.

### Config flag

```ts
linearChannel({
  excludeOtherThreads: true,
});
```

`LinearChannelConfig.excludeOtherThreads?: boolean` (default `false`)
strips `<other-thread>` blocks from the _default_ turn-message computation
in `dispatchAgentSession`. It does not touch `previousComments`: those are
the prior comments of the primary thread itself, not other threads, and
dropping them is a separate decision expressed via the hook override
below.

### Hook overrides

`LinearInboundResult` gains two optional fields:

```ts
export type LinearInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Replaces the computed turn message. Empty/whitespace-only string or
   *  empty array is treated as undefined (default computation applies).
   *  Array-form content skips Linear inbound image attachment. */
  readonly message?: UserContent;
  /** Replaces `event.previousComments` in the dispatched context.
   *  `[]` drops them; `undefined` keeps them. */
  readonly previousComments?: readonly string[];
} | null;
```

The documented recipe composes the default hook rather than reimplementing
its action filter (forgetting `return null` for unknown actions would
otherwise dispatch turns for future Linear webhook actions):

```ts
linearChannel({
  onAgentSession(ctx, event) {
    const base = defaultOnAgentSession(ctx, event);
    if (base === null) return null;
    return {
      ...base,
      message: messageFromLinearAgentSessionEvent(event, {
        excludeOtherThreads: true,
      }),
      previousComments: [],
    };
  },
});
```

### Helpers

- `messageFromLinearAgentSessionEvent(event, options?: { excludeOtherThreads?: boolean })`
  — existing public export gains an options parameter. With the flag set,
  stripping runs _before_ the emptiness check, so an all-other-threads
  `promptContext` falls through to the existing fallbacks
  (session summary → issue title → static string). The `prompted`
  activity-body path is unaffected.
- `stripLinearOtherThreads(text: string): string` — new pure helper in
  `inbound.ts`, exported from the channel index. Plumbing for the above;
  `messageFromLinearAgentSessionEvent` with options is the intended entry
  point.

## Semantics

### Stripping (fail closed)

- Opening tags carry attributes in real payloads
  (`<other-thread comment-id="…">`), so matching uses
  `<other-thread\b[^>]*>` through the paired `</other-thread>`,
  non-greedy, all occurrences. `<primary-directive-thread …>` is
  preserved.
- Whitespace is normalized only at splice points; formatting inside the
  preserved primary thread is untouched.
- **Fail closed:** if the stripped output still contains `<other-thread`
  (case-insensitive) — format drift, or a comment body embedding a literal
  `</other-thread>` that truncated the match — the result is treated as
  empty so the message computation falls through to summary/title, and a
  warning is logged. A privacy filter must degrade, not silently leak.

### Dispatch (`dispatchAgentSession`)

- Message: `result.message ?? default`, where the default computation
  respects `config.excludeOtherThreads`. Overrides still flow through
  `attachLinearInboundImages` (string content only; array content is
  passed through untouched, matching existing behavior).
- Context: `[formatLinearContextBlock(event), ...(result.previousComments
?? event.previousComments), ...(result.context ?? [])]`.
- No behavior change when neither the flag nor the overrides are used.
  `formatLinearContextBlock` emits only IDs/titles/URLs and is not a leak
  vector; `event.guidance` is parsed but never dispatched.

### Known limitation

Parsed `previousComments` are body strings only — author identity is
discarded at parse time — so selective filtering (e.g. "drop only other
bots' comments") requires reading `event.raw`. The docs note this escape
hatch. Preserving structured authorship is left out deliberately
(YAGNI; revisit on demand).

## Tests (unit tier)

New `inbound.test.ts` plus dispatch cases in `linearChannel.test.ts`. All
stripping fixtures are realistic payloads modeled on Linear's documented
format (attributes on thread tags, `<comment author="…">` children), not
attribute-less toys — a literal-tag regex would pass toy fixtures while
matching nothing in production.

- `stripLinearOtherThreads`: single and multiple blocks removed; primary
  thread and its formatting preserved; no-op without blocks; fail-closed
  on residual `<other-thread` (drift and embedded-literal cases);
  whitespace normalization at splice points.
- `messageFromLinearAgentSessionEvent` + `excludeOtherThreads`: stripped
  message; fall-through to summary/title when promptContext is entirely
  other threads; `prompted` activity body unaffected.
- Dispatch: config flag strips the default message; hook `message`
  override wins over the flag and still attaches images (string form);
  empty/whitespace-only override falls back to default; `previousComments`
  `[]` drops, non-empty replacement array is used, absence preserves
  today's behavior; prompted events with overrides still resolve pending
  HITL input.

## Docs and release

- `docs/channels/linear.mdx`: document the exposure itself (promptContext
  carries other agents' threads; cross-agent prompt-injection surface),
  the flag, the composed-hook recipe, and the `event.raw` escape hatch.
  Update the `LinearInboundResult` field enumeration ("Return `{ auth }`
  to dispatch…") and the JSDoc in `linearChannel.ts` — Linear is the only
  channel whose turn message is a Linear-computed aggregate of other
  actors' content, which is why it alone gets a `message` override.
- Patch changeset (additive, non-breaking).
