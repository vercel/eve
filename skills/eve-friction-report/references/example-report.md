# Example: what a finished report looks like

Abridged from a real, anonymized run against `<org>/eve @ <sha>` (eve 0.63.0). The full
report had 17 blocks; two are reproduced here in full, followed by a weak block and why it
fails. Match this shape exactly.

---

```markdown
---
status: draft
last_updated: "2026-09-29"
subject:
  repo: "<org>/eve @ <sha> (main, 2026-09-22)"
  eve_pinned: "0.63.0"
  eve_compared_against: "eve@0.63.0 tag docs; CHANGELOG through 0.66.1"
scope: "read-only; every claim cites path:line; [V] read, [I] inferred from the code path, [R] unverified"
---

# <org>/eve (<agent>): eve gap register

18 gaps. The files that carry the workarounds total ≈5,800 of 24,237 lines of `agent/`
TypeScript. No static internal imports; one dynamic import of `eve/dist` in a test helper and three runtime reach-ins into `channel.adapter[...]`. Every
eve `limits.*` is `false`. The team has filed one issue against eve, withdrawn.

| | |
|---|---|
| Pin history | 0.30.6 (08-04) → 0.37.0 (08-13) → 0.44.0 (08-21) → 0.52.2 (09-08) → 0.57.0 (09-16) → 0.63.0 (09-22) |
| Surface | 9 channels, 53 authored tools (+50 re-exports in subagents), 6 subagents, 8 hooks, 5 schedules, 6 connections, 1 sandbox, browser + GitHub extensions, 6 skills, 11 evals, 77 tests; `instructions.md` 25,664 bytes |
| Filed against eve | 1 issue by <person-1>, closed as withdrawn (number withheld). `--search <org>`: 0 results. 2026-09-29 |
| Code hygiene | formatter/linter: none (no config file, no `lint`/`format` script); 982 of 24,237 `agent/**/*.ts` lines >120 chars, 271 >200, 52 >400; densest file `lib/factory/<org>-internal-app-skill.ts` at 182 chars/line. eve's four `apps/templates/*` and the `eve init` scaffold ship no formatter or linter either [V] |

## Index

| ID | Gap | Kind | Workaround (lines) | Tracked |
|---|---|---|---|---|
| [A1](#a1-slack-posts-from-app-code-have-no-idempotency-reconciliation-or-chunking) | Slack posts from app code: no idempotency, reconciliation, chunking | own | ~3,200 | none |
| [A2](#a2-no-turn-level-idle-deadline-no-in-process-cancel) | No turn-level idle deadline; no in-process cancel | own | ~660 | none |
| [A3](#a3-step-usage-has-no-served-model-id-compaction-and-auto-calls-are-unmetered-root-hooks-do-not-fire-in-subagents) | Cost attribution: no served model id, unmetered compaction/`auto()`, hooks not inherited | own | ~530 | #3483 |
| … | | | | |

## Upgrade exposure (0.63.0 → 0.66.1)

| Change | Files that break | Changelog |
|---|---|---|
| `todo` tool and `eve/tools/todo` export removed (0.65.0) | `agent/tools/todo.ts`, 5× `agent/subagents/*/tools/todo.ts`, `factory/project-progress.ts:11-25` | `60998d6`, named [V] |
| `setNetworkPolicy` removed from `SandboxSession` (0.66.0) | `lib/sandbox-network.ts:100`, `lib/factory/station-git.ts:189-203` | `ee286fe`, named [V] |
| `ask_question` `requestId` no longer the tool call id (0.65.0) | `factory/brief-response.ts` Redis key (A10) | `60998d6`, named; effect [I] |
| Tool contract 21 → 44 at 0.57.0 (A6) | browser extension manifest | not named; only generic 0.50.0 / 0.59.0 notices [V] |

## Tool shape

How the project distributed behavior between tools, approval policy, and instructions.
Facts from `sweep.sh` S12 and the files opened; not a gap block, because eve's approval
policy already receives the tool input.

| | |
|---|---|
| Authored tool files | 53 at the root (8 plain re-exports of `eve/tools/*`), plus 50 re-exports under `agent/subagents/*/tools/` (A11) |
| Tools with their own `approval:` config | 15 of 53; approval is attached per tool, and 9 tools import the project's own `private-approval` delivery (A4) |
| Tool names referenced in `instructions.md` | 18 of 53; `instructions.md` is 25,664 bytes and names 8 of the 10 `factory_*` tools individually |
| What eve supports | `docs/tools/human-in-the-loop.md:41`: "When the decision depends on the input, pass your own policy instead of a helper. It receives the same session context as tool execution, plus `{ toolName, toolInput, approvedTools, callId }` … Return `"user-approval"` to pause for a person or `"not-applicable"` to continue without a prompt." [V] |

| Family | Members | Lines | With approval | Shared backend (`lib/` imports common to ≥2 members) |
|---|---|---|---|---|
| `factory_*` | 10 | 1,199 | 8 | `factory/authority`, `factory/context`, `factory/github`, `factory/resources`, `factory/runs`, `factory/vercel`, `private-approval` |
| `receipt_*` | 5 | 464 | 2 | `receipt-bridge`, `receipt-gate`, `receipt-review-store`, `slack-identity`, `private-approval` |
| `twitter_*` | 4 | 275 | 0 | none (each carries its own fetch) |
| `blob_*` | 3 | 159 | 1 | `config` |
| `customer_classification_*` | 3 | 90 | 2 | `customer-intelligence-client`, `private-approval` |
| `company_*` | 2 | 93 | 0 | `company-data-access` |

The narrowest member of the `receipt_*` family is a subset of another member: it imports the
other tool's `execute` helper and re-exposes it with two of the seven fields. The description
tells the model which fields the tool accepts.

`agent/tools/receipt_update_current_company.ts:6-26` (long line elided with `…`)

```ts
import { updateCurrentReceiptCandidate } from "./receipt_update_current_candidate";

export const CurrentReceiptCompanyInputSchema = z.object({
  receiptNumber: z.number().int().min(1).max(2000),
  company: z.enum(RECEIPT_COMPANIES),
}).strict();
type CurrentReceiptCompanyInput = z.infer<typeof CurrentReceiptCompanyInputSchema>;

export default defineTool({
  description:
    "Change only the destination company for one numbered receipt in the authenticated pilot review. This tool accepts exactly receiptNumber and company, preserves every …
  inputSchema: CurrentReceiptCompanyInputSchema,
  async execute(input, ctx) {
    assertReceiptPrivateContext(ctx.session.auth.current);
    return updateCurrentReceiptCandidate(input, {
      actor: slackUserIdFromPrincipal(
        ctx.session.auth.current as SlackAuthorizationPrincipal | null | undefined,
      ),
    });
  },
});
```

`agent/tools/receipt_update_current_candidate.ts:15-24` (the seven-field schema the subset tool narrows)

```ts
export const CurrentReceiptUpdateInputSchema = z
  .object({
    receiptNumber: z.number().int().min(1).max(2000).optional(),
    merchant: z.string().min(1).max(160).optional(),
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    amount: z.number().finite().nonnegative().max(100_000_000).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
    company: z.enum(RECEIPT_COMPANIES).optional(),
    reference: z.string().min(1).max(160).nullable().optional(),
  })
```

---

## A2. No turn-level idle deadline; no in-process cancel

Kind: own · Area: tasks

**Gap.** eve has no "no meaningful activity for N minutes" signal or policy on a turn.
`limits.sessionTimeoutMs` is a whole-session lifetime (default 30 days). Cancel exists as the
model tool `task_cancel` and as an HTTP endpoint; hooks and schedules have no in-process
cancel.

**What eve says.** `docs/agent-config.md:153-175` (0.63.0): `limits` are token caps plus
session lifetime. `docs/subagents/index.mdx` (0.63.0): cancel only via `task_cancel`.
`docs/concepts/sessions-runs-and-streaming.md:223-238`: `POST /eve/v1/session/:id/cancel`.
0.66.1 `d6fc658` fails a delegated task when its yielded child session ends; nothing detects
an idle turn. `research/background-tasks-redesign.md` (#1084) has no stall concept. [V]

**What the project built.** A hook subscribed to 12 events writes per-turn activity to
Redis; a 1-minute schedule scans it; at 5 min it posts "Eve is still working on this task",
at 10 min marks stalled, at 20 min cancels the turn over HTTP with a Vercel OIDC token and
posts a partial report through the A1 outbox. Thread identity is recovered by parsing
`context.channel.continuationToken` as `…:<channelId>:<threadTs>` (`task-supervision.ts:76-92`).
Since 2026-08-20 (pin 0.37.0), hardened 2026-09-10: "make supervision
distinguish progress, stalls, cancellation, and retryable observation failures." One week after
the supervisor landed, every eve limit was disabled (2026-08-27, "disable Eve
session limits"). [V]

**How it fails.** Silently. Every error in the hook is swallowed (`:580-588`); a renamed
event, a changed `data` shape (`:266-288`), or a changed continuation-token format stops
tracking with no signal. Thresholds are wall-clock: a healthy 25-minute tool call is
cancelled. Production stall and false-cancel rates were not observed [R]. 0.66.1 `d6fc658`
may make the parent/child bookkeeping at `:332-347` redundant [I].

`agent/lib/task-supervision.ts:13-15`

```ts
export const TASK_PROGRESS_AFTER_MS = 5 * 60_000;
export const TASK_STALLED_AFTER_MS = 10 * 60_000;
export const TASK_CANCEL_AFTER_MS = 20 * 60_000;
```

`agent/lib/task-supervision.ts:213-236`

```ts
export function createEveCancellationTransport(input: {
  readonly fetcher?: typeof fetch;
  readonly token?: () => Promise<string>;
  readonly url?: () => string;
} = {}): TaskCancellationTransport {
  const fetcher = input.fetcher ?? fetch;
  const token = input.token ?? (() => getVercelOidcToken());
  const url = input.url ?? publicEveUrl;
  return {
    async cancel({ sessionId, turnId }) {
      const response = await fetcher(`${url()}/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        headers: {
          authorization: `Bearer ${await token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnId }),
      });
      if (!response.ok) throw new Error(`Eve cancellation failed with HTTP ${response.status}.`);
```

`agent/lib/task-supervision.ts:295-297`

```ts
      : "The supervisor requested cancellation after 20 minutes without meaningful activity.";
  return [
    "# Eve task stalled",
```

`agent/lib/task-supervision.ts:580-588`

```ts
  try {
    await defaultTaskSupervisor().handle(event, context);
  } catch {
    // Monitoring is observational: its outage must not abort useful agent work.
    // Omit provider error text because it can contain credentials or customer data.
    logEvent("error", "task.supervision.observation_failed", {
      sessionId: context.session.id, eventType: event.type,
    });
  }
```

`agent/agent.ts:28-34`

```ts
  // Long-running work continues without cumulative usage approval prompts.
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    maxTokenCostUsdPerSession: false,
    sessionTimeoutMs: false,
  },
```

---

## A12. The Slack `ts` of eve's own reply is not exposed

Kind: buildable · Area: channels

**Gap.** After the built-in `message.completed` handler posts the reply, no event, state
field, or return value carries the Slack message id. Authored code cannot annotate, edit, or
thread off eve's own answer without replacing the whole default renderer.

**What eve says.** `postCompletedSlackReply` returns `void`; `SlackChannelState`
(`slackChannel.ts:216-260` at 0.63.0) has `triggeringMessageTs` and no reply ts.
`docs/channels/slack.mdx:428`: "An authored `events["message.completed"]` handler replaces this
behavior and owns its own delivery limits" — you lose the 12k/snippet chunker to get the id.
vercel/eve#3974 (open, 2026-09-29, another customer): "Slack: let a hook see which message a
turn posted." [V]

**What the project built.** `captureSlackReply` re-wraps `adapter["message.completed"]`, wraps
`context.thread.post` in a `Proxy` to capture `result.id`, stores it in channel state, then
edits that message to append an admin context block (`slack-admin-delivery.ts:13-79`, ~50
lines). Since 2026-09-22 (pin 0.63.0): "admin diagnostics were lost for Eve's
channel:slack events … capture the accepted Slack reply and append its metadata as a context
block." Own words: "Keep Eve's stock reply renderer while retaining its accepted Slack message
id." [V]

**How it fails.** Loud at boot if `adapter` or the key changes (explicit throw). Silent when
the default handler delivers as a file snippet (>12k chars) and never calls `post`:
`adminReply` stays null and the footer falls back to a separate message.

`agent/lib/slack-admin-delivery.ts:13-31`

```ts
/** Keep Eve's stock reply renderer while retaining its accepted Slack message id. */
export function captureSlackReply(channel: SlackChannel): SlackChannel {
  const runtime = channel as RuntimeChannel;
  const native = runtime.adapter?.["message.completed"];
  if (typeof native !== "function") throw new Error("The installed Eve Slack reply adapter is incompatible with admin metadata.");
  return {
    ...runtime,
    adapter: {
      ...runtime.adapter,
      state: { ...runtime.adapter.state, adminReply: null },
      async "message.completed"(event: Completed, context: Context) {
        let messageTs = "";
        const thread = new Proxy(context.thread, { get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "post") return async (...args: Parameters<typeof target.post>) => {
            const result = await target.post(...args);
            messageTs = result.id;
            return result;
          };
```
```

---

## A weak block, and why it fails

```markdown
## A5. Budgets

**Gap.** The project needed better budgeting than eve offers, so it built its own.

**What eve says.** eve has session limits but they weren't flexible enough.

**What the project built.** A Redis budget system in `<app-2>-budget.ts` and related files.
This is a reasonable approach given the constraints.

**How it fails.** Could break on upgrade.

```ts
// budget enforcement
if (overBudget) throw new Error("over budget");
```
```

Every paragraph fails the standard:

- **Gap** describes the project, not eve. It should name the eve primitive
  (`limits.maxTokenCostUsdPerSession`) and state what it cannot express (per-request,
  per-day, per-principal).
- **What eve says** has no citation and no quote. It should cite `docs/agent-config.md:153-207`
  at the pinned version, quote the sentence, and name the tracking issue and its state.
- **What the project built** has no line ranges, no size, no first commit, no pin at that
  time, and no quote from the project. "Reasonable approach" is an opinion; delete it.
- **How it fails** names no dependency. It should say which call path is unmetered and that
  `settle()` returns early when usage is unknown, with the line.
- The excerpt is paraphrased. `check-report.mjs` rejects it: there is no `path:start-end`
  heading and the lines do not exist in the repo.
