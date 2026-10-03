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
| [A4](#a4-approval-delivery-cannot-target-a-designated-approver) | Approval delivery cannot target a designated approver | own | ~450 | none |
| [A5](#a5-limits-are-per-session-lifetime-caps-nothing-per-request-day-or-principal) | Limits are per-session lifetime caps only | own | ~300; all limits `false` | #551 |
| [A6](#a6-a-published-extension-stops-mounting-on-every-capability-contract-bump) | Published extension stops mounting on each contract bump | own | vendored package | agent-browser#1841 |
| [A7](#a7-workflow-tool-yield-progress-is-not-rendered-in-slack) | Workflow-tool `yield` progress not rendered in Slack | own | ~200 | #2087 adj. |
| [A8](#a8-evechannel-route-auth-does-not-bind-a-session-to-its-creator) | `eveChannel` does not bind a session to its creator | own | ~120 | none |
| [A9](#a9-verceloidc-admits-other-project-development-tokens-only-as-service) | Cross-project dev tokens admitted only as `service` | buildable | ~90 | none |
| [A10](#a10-ctxask-answers-carry-no-responder-identity) | `ctx.ask()` answers carry no responder | own | ~68 | none |
| [A11](#a11-declared-subagents-inherit-no-tools-hooks-or-skills) | Subagents inherit nothing | buildable | 58 files | #626 |
| [A12](#a12-the-slack-ts-of-eves-own-reply-is-not-exposed) | Posted reply `ts` not exposed | buildable | ~50 | #3974 |
| [A13](#a13-auto-cannot-be-composed-reasoning-enum-stops-at-xhigh) | `auto()` not composable; no `max` reasoning | buildable | ~35 | #3676, #2022 |
| [A14](#a14-defineschedule-has-no-timezone) | `defineSchedule` has no timezone | own | ~20 | none |
| [A15](#a15-githubchannel-sandbox-checkout-cannot-be-disabled) | GitHub channel checkout cannot be disabled | buildable | 1 override | none |
| [A16](#a16-runtime-value-of-ctxchannelkind-is-undocumented) | `ctx.channel.kind` value undocumented | docs | 1 line | none |
| [A17](#a17-sandbox-fingerprint-scope-is-undefined) | Sandbox fingerprint scope undefined | docs | manual key bumps | none |
| [A18](#a18-definestate-and-context-accessors-cannot-run-outside-an-eve-execution-so-tests-import-the-container-from-dist) | `defineState` cannot run outside an eve execution; tests import the container from `dist` | buildable | ~10 | none |

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

## A1. Slack posts from app code have no idempotency, reconciliation, or chunking

Kind: own · Area: delivery

**Gap.** eve owns the Slack transport, token resolution, and the 12,000-character/snippet
chunking for model replies. App code that posts outside a model reply (scheduled digests,
progress cards, recovery notices) gets `callSlackApi` / `ctx.thread.post` with no
idempotency key and no reconciliation when Slack accepts a post but the response is lost.

**What eve says.** `docs/patterns/durable-cross-channel-notifications.md:6-8`: "eve does not
currently provide a direct cross-channel message queue or provider outbox … An
application-owned outbox is the current pattern for durable provider notifications. It
provides at-least-once processing. It does not by itself guarantee exactly-once delivery."
Same text at 0.63.0 and HEAD. `src/public/channels/slack/api.ts:84-98`: `postSlackMessage`
whitelists request fields; no caller-supplied idempotency key reaches Slack. [V]

**What the project built.** A Redis-backed write coordinator (1,301 lines) with deterministic
`client_msg_id`, readback reconciliation against `conversations.replies`, persisted
Retry-After, and locks; a long-task delivery runtime (981 lines) with chunking and resumable
uploads; a raw-JSON Slack adapter because eve's form encoder drops `client_msg_id`; receipt
state machines and stores; a 1-minute drain schedule that also serves five other project
outboxes. Since 2026-08-20 (pin 0.37.0); coordinator 2026-09-08. The team
already moved ordinary model replies back to eve in 2026-09-16: "Custom Slack
handlers were … duplicating long-response delivery that the current framework owns … retain
the durable outbox only for <org>-owned proactive, factory, and recovery messages." [V]

**How it fails.** Fail-closed on Redis or Blob outage (loud). Silent on Slack semantics: the
coordinator assumes `metadata.event_type` and `client_msg_id` echo back in
`conversations.replies`; if eve's channel starts posting its own metadata or the raw adapter
diverges from eve's token handling, the result is duplicates or keys stuck "in-flight" for
the 30 s horizon. Whether Slack honors form-encoded `client_msg_id` at all was not tested [R].

`agent/lib/slack-write-coordinator.ts:143-149`

```ts
/**
 * Slack's Web API can accept a post while the response is lost. Keep an
 * in-flight logical key in readback-only mode for this horizon before another
 * request is considered. The history lookup must complete before that clock
 * can advance; a partial page is never treated as proof of absence.
 */
export const SLACK_AMBIGUOUS_READBACK_HORIZON_MS = 30_000;
```

`agent/lib/slack-write-coordinator.ts:210-216`

```ts
/**
 * Slack accepts `client_msg_id` only in UUID form. Deriving UUIDv4-shaped
 * bytes from the logical operation key gives every retry the same identity
 * without pretending this is a random identifier.
 */
export function deterministicSlackClientMessageId(logicalKey: string): string {
  const bytes = hashBytes(`eve-slack-delivery:v1:${logicalKey}`);
```

`agent/lib/scheduled-slack.ts:107-108`

```ts
/** Raw JSON Slack API adapter; unlike Eve's form normalizer, preserves client_msg_id. */
export function createScheduledSlackApi(
```

`agent/schedules/delivery-outbox.ts:16-20`

```ts
/**
 * Drain durable long-task Slack deliveries. The schedule only retries
 * persisted records; it never starts or repeats model/tool work.
 */
export default defineSchedule({
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

## A3. Step usage has no served model id; compaction and `auto()` calls are unmetered; root hooks do not fire in subagents

Kind: own · Area: cost

**Gap.** A per-turn or per-task cost total cannot be assembled from eve's events. `step.completed`
carries `usage` but not which model actually served the step (Gateway fallback can differ from
the requested id); routing (`auto()`) and compaction model calls emit no usage; and a root hook
does not see subagent turns, so the same hook must be authored in every subagent.

**What eve says.** `src/harness/step-hooks.ts:338-350` (0.63.0): `step.completed` payload has
`usage` and `providerMetadata`, no model id; served model reaches only instrumentation
(`src/instrumentation/lifecycle.ts:439`, `responseModelId`). `src/models/auto.ts:167` calls
`evaluate()` with no usage capture (grep `usage|cost` empty at pin and HEAD).
`docs/guides/hooks.md:183`: "Parent-agent hooks do not fire for subagent turns"
`docs/agent-config.md:153-207` (0.63.0): `maxTokenCostUsdPerSession` is enforcement, "not
tool or infrastructure spend"; no readout. 0.66.1 `d6fc658` adds usage on delegated task
results (task level, not hooks). vercel/eve#3483 (open, 2026-09-17) asks for compaction usage
evidence. [V]

**What the project built.** A 363-line cost ledger keyed by Gateway generation id with a
positional fallback and an `ambiguous` bucket; a Redis bridge (30-minute TTL) that carries the
served model from an instrumentation span to the hook that renders the Slack footer; a
`defineState` accumulator for the admin footer; and the cost hook copied into five subagents.
Since 2026-09-08 (pin 0.52.2) and 2026-09-22. Own words: "Usage is a
reply-model subtotal. Eve does not expose <app-3>/tool/compaction billing here." and "Eve does not
inherit root hooks into declared subagents." [V]

**How it fails.** Silent undercount: the footer prints "(partial)" or "unavailable"; the
factory readout sets `complete:false` with no alert (`factory/cost.ts:324-335`). The Redis
bridge is keyed on `sessionId:turnId`; a change in id shape drops the served model silently.
That Gateway fallback actually serves a model other than `step.started.modelId` (the bridge's
motivation) was not observed in a trace [I].

`agent/lib/slack-admin-usage.ts:18`

```ts
/** Usage is a reply-model subtotal. Eve does not expose <app-3>/tool/compaction billing here. */
```

`agent/hooks/factory-cost.ts:8-15`

```ts
/**
 * Capture completed model usage before a factory task binds its exact turns.
 *
 * Eve does not inherit root hooks into declared subagents. If this hook is
 * mounted in a station as well, the child branch below binds that station's
 * own session/turn to the factory task. The root branch deliberately records
 * only: the factory workflow binds its exact root turn explicitly.
 */
```

`agent/lib/factory/cost.ts:160-165`

```ts
  const ambiguous = !validCoordinates || generationId === undefined;
  const identity = generationId !== undefined
    ? `generation:${generationId}`
    : validCoordinates
      ? `fallback:${JSON.stringify([sessionId, turnId, stepIndex, sequence])}`
      : ambiguousIdentity({ sessionId, turnId, stepIndex, sequence, generationId, costUsd });
```

`agent/subagents/{analyst,classifier,implementer,researcher,reviewer}/hooks/factory-cost.ts:1`

```ts
export { default } from "../../../hooks/factory-cost";
```

---

## A4. Approval delivery cannot target a designated approver

Kind: own · Area: hitl

**Gap.** Slack `approvalChannel: "direct-message"` delivers a tool-approval request to the
user who triggered the turn. The common enterprise shape — a teammate requests, a fixed owner
approves — cannot be expressed, so the project owns delivery, the card, the click-to-request
binding, and the session resume.

**What eve says.** `docs/channels/slack.mdx:451`: "Return `"direct-message"` when the request
must be visible only to the Slack user who triggered the turn" The type comment at
`src/public/channels/slack/slackChannel.ts:647-650` (0.63.0) says the same. The internal
delivery function already accepts any reviewer:
`src/public/channels/slack/private-approval-delivery.ts:10-14` `deliverPrivateInputRequest({ reviewer })`.
`approvalChannel` shipped in 0.54.5, after this workaround existed. Unchanged through 0.66.1. [V]

**What the project built.** `privateApprovalChannel` re-wraps `adapter['input.requested']` and
`adapter['approval.settled']`, wraps the `/eve/v1/slack` route handler in an `AsyncLocalStorage`
to capture `attachSession`, renders its own approval card, DMs a hard-coded owner, and on click
resumes the session by calling `attach(sessionId).respond([...], { auth })` with a principal the
app synthesizes as `authenticator: 'slack-webhook'`. The same pattern is repeated for a
`workflow/api` `resumeHook` in `factory/build-approval.ts:58-102`. ~450 lines across
`private-slack.ts`, `private-approval.ts`, `private-approval-summary.ts`, `slack-dm.ts`,
`slack-presentation.ts:136-150`. Since 2026-09-08 (pin 0.52.2). Own words: "Narrow,
version-checked bridge: stock verification and question rendering remain intact." and
"Write approvals are owned by the private Slack approval channel, including delivery retries"
(`hooks/factory-approval-context.ts:3`). [V]

**How it fails.** Loud at boot if the adapter keys or the route path move (explicit throw,
asserted in `tests/security-surface.test.ts:39`). Silent afterwards: the resume path forges a
`slack-webhook` principal that eve cannot distinguish from a signed webhook [I]; if eve ever
validates responder provenance, approvals stop with no error. The `AsyncLocalStorage` capture
depends on the route handler's second argument carrying `attachSession`.

`agent/lib/private-slack.ts:8-24`

```ts
type RuntimeSlackChannel=SlackChannel & {adapter:Record<string,unknown> & {
 'input.requested'?: (event:InputEvent,ctx:BridgeContext)=>void|Promise<void>;
 'approval.settled'?: (event:SettledEvent,ctx:BridgeContext)=>void|Promise<void>;
}};

/** Narrow, version-checked bridge: stock verification and question rendering remain intact. */
export function privateApprovalChannel(channel:SlackChannel):SlackChannel {
 const runtime=channel as RuntimeSlackChannel;
 const nativeInput=runtime.adapter?.['input.requested'];
 const nativeSettled=runtime.adapter?.['approval.settled'];
 if(typeof nativeInput!=='function' || !channel.routes.some(r=>r.transport==='http'&&r.path==='/eve/v1/slack'))throw new Error('The installed Eve Slack adapter is incompatible with private approvals. Refusing to start.');
 return {...runtime,
  routes:channel.routes.map(route=>route.transport==='http' && route.method==='POST' && route.path==='/eve/v1/slack'
    ? {...route,handler:(request,args)=>approvalRouteContext.run(args.attachSession,()=>route.handler(request,args))}:route),
  adapter:{...runtime.adapter,
   async 'input.requested'(event:InputEvent,ctx:BridgeContext){
    const privateRequests=event.requests.filter(r=>r.kind==='tool-approval');
```

`agent/lib/private-approval.ts:160-165` (synthesized principal on resume; long lines elided with `…`)

```ts
 const attach=approvalRouteContext.getStore();if(!attach)throw new Error('Private approval routing is unavailable. No change was authorized.');
 const won=await redis.eval(`local r=redis.call('GET',KEYS[1]);if not r then return 0 end;…`, …);
 if(Number(won)!==1)return true;
 const auth={authenticator:'slack-webhook',principalType:'user',principalId:`slack:${TEAM}:${<person-1>}`,attributes:{team_id:TEAM,user_id:<person-1>,channel_id:row.dmChannelId!,thread_ts:row.messageId!,…}};
 try{
  await attach(row.routeSessionId).respond([{requestId:row.requestId,optionId:decision}],{auth});
```

---

## A5. Limits are per-session lifetime caps; nothing per request, day, or principal

Kind: own · Area: budgets

**Gap.** eve's `limits` are session-scoped token and cost ceilings that pause the session with
an Approve/Stop prompt when reached. There is no per-request, per-day, or per-principal budget
and no way to reserve spend before a step runs.

**What eve says.** `docs/agent-config.md:153-207` (0.63.0): `maxInputTokensPerSession`,
`maxOutputTokensPerSession`, `maxTokenCostUsdPerSession`, `sessionTimeoutMs`; pause plus a
continuation prompt; "Set any usage limit to `false` to uncap that axis." vercel/eve#551
"Uncapped sessions by default: remove session token limits, add caller-scoped run budgets"
open since 2026-07-06. No changelog entry through 0.66.1. [V]

**What the project built.** Every limit set to `false` (`agent/agent.ts:29-33`; also
`lib/model.ts:142,297-302`), and a Redis Lua reserve/settle budget ("$1 per request, $10
daily") enforced inside a `LanguageModelMiddleware` (`<app-2>-budget.ts`, `<app-2>-query-lease.ts`,
`<app-2>-model.ts:574-719`, ~300 lines). Since 2026-09-09 (pin 0.52.2); limits disabled
since 2026-09-08, whose replaced comment read "Cost protection is handled by Vercel
budget notifications. Explicitly disable eve's token and lifetime caps so its field-specific
defaults do not interrupt interactive sessions." The project also runs a weekly schedule that
polls vercel/eve#551 (`upstream-reliability-monitor.ts:19-24`). [V]

**How it fails.** Silently. The budget lives in a middleware around one model; compaction,
`auto()` routing, and subagent steps that do not pass through the wrapped model are never
metered. `settle()` returns early when the provider reports no usage, leaving the reservation
in place but recording nothing.

`agent/lib/<app-2>-budget.ts:70-74` (long lines elided)

```ts
   if (result < 0) throw new Error(result === -1 ? "The next model step would exceed this request’s $1 allowance." : result === -2 ? "The next model step would exceed <app-2>’s $10 daily allowance." : …);
   return { keys, amount };
  },
  async settle(reservation: { keys: string[]; amount: number }, actual: number, usage: { model?: string; inputTokens?: number; outputTokens?: number } = {}) {
   if (!Number.isSafeInteger(actual) || actual < 0) return; // retain full reservation when usage is unknown
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

## A6. A published extension stops mounting on every capability-contract bump

Kind: own · Area: extensions

**Gap.** eve refuses to mount an extension built against an older capability contract. A
consumer of a third-party extension whose maintainer has not republished must vendor the
source and rebuild it on each bump. The bumps themselves are not named in the changelog.

**What eve says.** `docs/extensions.md:337-339` (0.63.0): "If the extension needs an
unsupported capability contract, upgrade eve or install a compatible extension release."
CHANGELOG notices: 0.50.0 "Extensions built against the previous … capability contracts must
be rebuilt and republished" (no numbers); 0.59.0 `7973fa2` "Rebuild extensions with the
current eve compiler"; 0.62.0 `fcb3ba2`. No entry names the tool-contract change 21 → 44 at
0.57.0. 0.66.1 `055f1d1` builds workspace-local source extensions only. [V]

**What the project built.** `vendor/agent-browser-eve/**` — the upstream source plus a
checked-in `dist`, rebuilt at the 0.52.2 → 0.57.0 bump and again at the 0.57.0 → 0.63.0
bump; `build:extensions` script; two docs recording provenance. Since 2026-09-08. Own words: "The browser remains vendored only because upstream issue #1841 leaves
the published manifest incompatible" (0.57.0 upgrade commit); "It remains a private compatibility rebuild
only because the published extension's generated manifest does not mount on current Eve"
(`docs/dependency-upgrade-notes.md:22`). [V]

**How it fails.** Loud at build (mount refused), then recurring manual work on every bump.
Risk of silently running stale vendored tool code after upstream fixes.
vercel-labs/agent-browser#1841 closed 2026-09-11; whether a published release now mounts on
0.63 was not checked [R].

`docs/browser-extension-compatibility.md:10-14, 22-24`

```
The published `@agent-browser/eve@0.38.1` distribution was built with Eve
0.47.3 and required tool contract 21. Eve 0.57.0 no longer consumes that
contract. The source itself builds against the current Eve package without API
changes, so this package is rebuilt locally rather than changing the manifest
by hand or disabling the browser mount.

The generated `dist/extension/_manifest.json` records `builtWithEve: "0.57.0"`
and requires tool contract 44, along with extension 1, instructions 2, and
config 1. Eve 0.57.0 reports no unsupported requirements for that manifest.
```

---

## A7. Workflow-tool `yield` progress is not rendered in Slack

Kind: own · Area: channels

**Gap.** A `defineWorkflowTool` body `yield`s progress, which becomes an `action.partial`
event. The Slack channel's default handlers and activity renderers do not handle
`action.partial`, so a multi-phase workflow shows no phase progress in Slack. Background
yields are dropped entirely.

**What eve says.** `docs/tools/workflows.mdx:18-19` (0.63.0): "Use `yield` to report
progress"; `:438`: "Emits an `action.partial` snapshot for the pending tool call" and, for
background tools, "Consumes the value without publishing progress" Slack defaults at
`src/public/channels/slack/defaults.ts:417-609` (0.63.0) handle `turn.started`,
`reasoning.*`, `actions.requested`, `message.completed`, failures, authorization — not
`action.partial`; `experimental_slackActivityStatus/Tree` key on `actions.requested` and
`action.result`. Grep for `action.partial` in `defaults.ts`/`activity*.ts` is empty at HEAD;
the type slot exists (`slackChannel.ts:591`) with no default. `research/background-tasks-redesign.md:25`:
background yields have no progress stream by design. vercel/eve#2087 (subagent nested progress)
is adjacent. [V]

**What the project built.** Each factory phase is published from a durable step to one
editable Slack status card keyed in Redis by `sessionId:turnId`, refreshed by the A1 outbox
schedule, and also `yield`ed. `slack-progress.ts`, `factory/experience.ts:21-36,51-110`,
`factory/steps.ts:51-55`, `software_factory.ts:17-21`, ~200 lines. Since 2026-09-08. Own words: "One status card per durable turn. Final answers are separate
notifications." and "Authoritative workflow boundaries publish directly, independent of hook
projection." [V]

**How it fails.** Silent duplication if eve later renders `action.partial`: two progress
surfaces in one thread. The card lives outside eve's activity tree and is not cleared on
cancel. Whether both surfaces already render together for a factory run was not observed [I].

`agent/lib/slack-progress.ts:6-8`

```ts
/** One status card per durable turn. Final answers are separate notifications. */
export async function updateSlackProgress(input:{sessionId:string;turnId:string;target:SlackWriteTarget;getToken:()=>Promise<string|null>;phase:string;…}){
  const key=`eve:slack-progress:v1:${input.sessionId}:${input.turnId}`;
```

`agent/tools/software_factory.ts:19-22`

```ts
    const progress=async(phase:string)=>{
      await publishFactoryPhase(taskId,ctx.callId,phase,++phaseOrdinal,ctx.session);
      return {phase,taskId,repository:run.context.repository};
    };
```

---

## A8. `eveChannel` route auth does not bind a session to its creator

Kind: own · Area: auth

**Gap.** Route auth on `eveChannel` identifies the caller, but nothing ties a session id to
the principal that created it. Any authenticated caller who learns a session id can stream,
continue, cancel, or reset another user's session. The MCP channel has this binding; HTTP
does not.

**What eve says.** `docs/guides/auth-and-route-protection.md:273-275`: "There's no second
per-session ownership ACL stacked on top of route auth … Route auth does not enforce session
ownership. If multiple users or tenants can reach the same route, you must implement the
per-user, per-tenant, or per-session authorization your application requires."
`docs/patterns/multi-tenant-auth.md:294` repeats it. Contrast `docs/channels/mcp.mdx:214-216`:
"an invocation belongs to the principal that started it; knowing its ID is not sufficient."
Same text at 0.63.0 and 0.66.1. [V]

**What the project built.** `with<org>SessionOwnership` wraps every `eveChannel` route handler,
regex-matches `/eve/v1/session/:id`, clones and re-parses the create response body for
`sessionId`, claims it in Redis, and returns 503 if the claim fails. Two hard-coded eve route
allowlists (`<org>-eve-auth.ts:17-21`, `<app-2>-auth.ts:60-98`), the latter pinned to "the strict
Eve 0.52.2 response wire contract". ~120 lines plus tests. Since 2026-09-22 (pin
0.63.0). Own words: "Eve HTTP route auth alone does not enforce session ownership"
(`docs/architecture/<org>-embedding.md:23`). [V]

**How it fails.** Silently on additions: a new eve session route that does not match
`^/eve/v1/session/([^/]+)` bypasses the ownership check (or is rejected outright by the
allowlists) [I]. A renamed `sessionId` field in the create response turns every session create
into a 503. Body re-parsing inside an `AuthFn` (`<app-2>-auth.ts:84`) breaks if eve consumes the
body first.

`agent/lib/<org>-session-ownership.ts:36-52`

```ts
export function with<org>SessionOwnership<T extends ReturnType<typeof eveChannel>>(channel:T,getStore:()=><org>SessionOwnerStore=redisStore):T {
  return {...channel,routes:channel.routes.map(route=>{
    const handler=route.handler;
    return {...route,handler:(request,ctx)=>scope.run({store:getStore},async()=>{
      const response=await handler(request,ctx);
      const owner=scope.getStore()?.owner;
      if(owner&&request.method==="POST"&&new URL(request.url).pathname==="/eve/v1/session"&&response instanceof Response&&response.ok){
        try {
          const body=await response.clone().json() as {sessionId?:unknown};
          if(typeof body.sessionId!=="string"||body.sessionId.length>512)throw new Error("Invalid session acceptance");
          await getStore().claim(body.sessionId,owner);
        }catch{return Response.json({error:"Session ownership could not be saved. Acceptance is unconfirmed; do not blindly retry the task."},{status:503,headers:{"cache-control":"no-store"}});}
      }
      return response;
    })};
  })} as T;
}
```

`agent/lib/<org>-eve-auth.ts:17-21`

```ts
export function <org>EveRouteAllowed(method: string, path: string): boolean {
  return method === "GET" && ["/eve/v1/info", "/eve/v1/health"].includes(path)
    || method === "POST" && (path === "/eve/v1/session" || /^\/eve\/v1\/session\/[^/]+(?:\/(?:cancel|clear|compact|reset))?$/.test(path))
    || method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(path);
}
```

`docs/architecture/<org>-embedding.md:23-27` (last line elided with `…`)

```
Eve HTTP route auth alone does not enforce session ownership. The central
`with<org>SessionOwnership` boundary stores only session-to-verified-app/user
ownership in Eve's existing Redis. It gates stream, continuation, response,
cancellation, clear, compact and reset. Creation is not acknowledged as usable
until ownership is saved; unavailable storage fails closed. …
```

---

## A9. `vercelOidc` admits other-project development tokens only as `service`

Kind: buildable · Area: auth

**Gap.** A frontend project's local development calling a deployed eve presents a Vercel
development OIDC token from a different project. eve's helper accepts tokens from other
projects only when their `sub` matches a configured `subjects` entry, and then as a `service`
principal; it cannot yield a `user` principal for that developer.

**What eve says.** `src/public/channels/auth.ts:900-905` (0.63.0): development tokens with a
`user_id` claim authenticate as `principalType: "user"` only when both the token and the
configured project environment are `development`; "Tokens from other Vercel projects are
accepted only when their `sub` matches … `subjects`" (as service). The rule is not stated in
`docs/guides/auth-and-route-protection.md` at pin or HEAD. Unchanged through 0.66.1. [V]

**What the project built.** `<app-1>DevelopmentOidc` and `runVisualizerOidc` re-verify the token
with `@vercel/oidc` against two registered project ids and admit it as a user
(`http-auth.ts:91-119, 147-204`, ~90 lines). Since 2026-08-14 (pin 0.37.0). [V]

**How it fails.** Loud (401) if eve's acceptance rule changes; the workaround is otherwise
standalone. Whether it is still needed at 0.66.1 was not re-derived [R].

`agent/lib/http-auth.ts:147-155`

```ts
/**
 * Vercel development tokens represent the signed-in developer, so eve's
 * cross-project service matcher intentionally rejects them. <app-1> local
 * development still calls the deployed Eve service. Verify that user token
 * against one of the two exact registered <app-1> projects before admitting it as
 * a user. This preserves the original <org> deployment while allowing the
 * current <person-1> preview project used by <app-1> Workspace development.
 */
export function <app-1>DevelopmentOidc(
```

---

## A10. `ctx.ask()` answers carry no responder identity

Kind: own · Area: hitl

**Gap.** A workflow tool parked on `ctx.ask()` resumes with `{ optionId, text }` and does not
learn who answered. A question used as an authorization step ("approve this brief") must be
re-bound to the signed actor outside eve. Tool-approval `response` policies do receive a
`responder`; questions do not.

**What eve says.** `docs/tools/workflows.mdx:38-47` (0.63.0): `answer.optionId` only.
`docs/tools/human-in-the-loop.md:116`: `responder` exposed on tool-approval `response`
policies. `docs/channels/slack.mdx:237`: "re-check `ctx.session.auth.current` inside a
sensitive tool" — a parked workflow tool has no documented way to do that after `ctx.ask()`
resolves [I]. 0.65.0 `60998d6` changed the answer to `{ status, optionId?, text? }` with no
responder field, and noted "An `ask_question` request's `requestId` is no longer its tool call
ID." [V]

**What the project built.** The Slack `onInputResponse` gate writes `requestId → actor` to
Redis before eve resumes; the workflow reads it back and requires the same actor and answer on
duplicate delivery (`factory/brief-response.ts:15-68`, `channels/slack.ts:332-339`,
`private-slack.ts:31-33`). Since 2026-09-08 (pin 0.52.2). Own words: "Capture the
signed actor before native Eve resumes the answer (ctx.ask omits identity)." [V]

**How it fails.** Silently. The binding is keyed by `requestId`, whose meaning changed in
0.65.0; a mismatch makes `admitBriefResponse` return `false` and every brief answer is
rejected with no error.

`agent/lib/factory/brief-response.ts:40-42`

```ts
/** Capture the signed actor before native Eve resumes the answer (ctx.ask omits identity). */
export async function admitBriefResponse(response: {requestId: string; optionId?: string; text?: string},
  auth: SessionContext["session"]["auth"]["current"]): Promise<boolean> {
```

`agent/lib/factory/brief-response.ts:54-57`

```ts
  const answer = { ...binding, actor: user, optionId: response.optionId, text: response.text };
  // First signed decision wins; duplicate delivery must carry the same answer and actor.
  const result = await redis.set(key(`${response.requestId}:answer`), answer, { nx: true });
```

---

## A11. Declared subagents inherit no tools, hooks, or skills

Kind: buildable · Area: subagents

**Gap.** A declared subagent's directory is its own agent root. It gets framework defaults for
unauthored slots but never the root's authored tools, hooks, or skills. Sharing means a
workspace extension or a re-export file per slot per subagent.

**What eve says.** `docs/subagents/index.mdx:127` (0.63.0 and HEAD): "A declared subagent
inherits nothing from the root's authored slots … it never inherits the root's authored
version." `:208`: "When two subagents need the same procedure, package the skill in a
workspace extension and mount that extension in each subagent." `docs/guides/hooks.md:183`:
subagent hooks fire only in subagent scope. vercel/eve#626 "Allow declared subagents to
inherit selected parent capabilities" open since 2026-07-08. 0.66.0 `d50a774` ships
`eve/extensions/code` as a bundled toolset — a partial substitute for coding stations only. [V]

**What the project built.** 58 one-line re-export files: 10 tool names × 5 subagents
(`bash, glob, grep, read_file, write_file, todo, web_fetch, web_search, ask_question,
load_skill`), 5 hook copies, 3 skill copies. Variants have already drifted:
`analyst|implementer|reviewer/tools/glob.ts` import `eve/tools/glob` directly while
`classifier|researcher/tools/glob.ts` re-export the root. Since 2026-09-08. [V]

**How it fails.** Loud at build when a re-exported eve tool disappears: 0.65.0 removes
`eve/tools/todo` and says an `agent/tools/todo.ts` "now fails the build" — this project has
six. Silent when the root tool gains a guard (for example the operator approval on `bash`) and
a subagent variant imports `eve/tools/*` directly instead.

`agent/subagents/implementer/tools/bash.ts:1` (one of 50; `ls agent/subagents/*/tools | grep -c ts` → 80 files)

```ts
export { default } from "../../../tools/bash";
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

---

## A13. `auto()` cannot be composed; reasoning enum stops at `xhigh`

Kind: buildable · Area: models

**Gap.** `auto()` returns a dynamic model whose selection runs in a `step.started` handler.
There is no documented way to pre-empt or post-process that selection (channel-specific
overrides, provider options). Separately, the generic reasoning enum has no `max`, which
OpenAI accepts.

**What eve says.** `src/internal/runtime-model.ts:56` (0.63.0, identical at HEAD): enum ends at
`xhigh`; `docs/guides/evaluate.md:102-104` lists the same values. No composition hook for
`auto()` in `docs/guides/evaluate.md` or `docs/guides/dynamic-capabilities.md`. vercel/eve#3676
"Support max reasoning effort in agent definitions and dynamic model selections" open
2026-09-23; #2022 "Clarify the step-scoped dynamic model lifecycle contract" open. [V]

**What the project built.** `resolve<agent>Model` calls `router.events["step.started"]!(event, ctx)`
by hand, then re-derives Gateway and OpenAI options from the result; `max` is encoded as a
`"provider-default"` sentinel that the resolver translates (`model.ts:250-274`,
`<app-3>-router.ts:7-18`, ~35 lines). Since 2026-09-22 (pin 0.63.0), which replaced a
178-line custom router with `auto()`. Own words: "Eve 0.63's generic reasoning enum stops at
xhigh." and "Product-specific overrides surround Eve's native model router." [V]

**How it fails.** Silently. If `auto()` renames its event or changes its return shape, the
fallthrough at `model.ts:264-265` returns the raw selection and every override vanishes with
no error. The sentinel drops `max` if any other consumer reads `reasoning` literally.

`agent/lib/<app-3>-router.ts:7-9` (long line elided)

```ts
  // Eve 0.63's generic reasoning enum stops at xhigh. The model resolver sets
  // OpenAI's max effort explicitly when <app-3> returns this distinct choice.
  lunaMax: { model: "openai/gpt-6-luna", reasoning: "provider-default", … },
```

`agent/lib/model.ts:252-253`

```ts
/** Product-specific overrides surround Eve's native model router. */
export async function resolve<agent>Model(event: unknown, ctx: DynamicResolveContext, router = <agent>Router) {
```

`agent/lib/model.ts:263-268`

```ts
  const selected = await router.events["step.started"]!(event, ctx);
  const model = typeof selected === "string" ? selected : "model" in selected ? selected.model : selected;
  if (typeof model !== "string") return selected;
  const reasoning = typeof selected === "object" && "reasoning" in selected ? selected.reasoning : undefined;
  const openaiEffort = reasoning === "provider-default"
    ? model === "openai/gpt-6-luna" ? "max" : undefined
```

---

## A14. `defineSchedule` has no timezone

Kind: own · Area: schedules

**Gap.** Schedules take a cron expression evaluated in UTC. A "09:00 local, weekdays" cadence
cannot be written; it requires an hour window covering both DST offsets and a runtime gate.

**What eve says.** `docs/schedules.mdx:32,114` (0.63.0): "Vercel evaluates the expression in
UTC." Zero matches for `timezone` in `docs/schedules.mdx` at pin and HEAD; no changelog entry. [V]

**What the project built.** `cron: "0 16-19 * * 1-5"` fires four times a day; `isWeekdayPulseTime`
lets exactly one through in `<tz>` (`weekday-pulse.ts:39-49, 77-83`, ~20 lines).
Since 2026-08-04 (pin 0.30.6). [V]

**How it fails.** Silent double-fire or miss if DST rules change or the hour window is edited
without the gate; three of four daily invocations are no-ops.

`agent/schedules/weekday-pulse.ts:40-41, 77-79`

```ts
/** True only at 09:00 <city>; the cron wakes at both DST offsets. */
export function isWeekdayPulseTime(

/** Vercel cron is UTC; the local gate selects exactly one 09:00 delivery. */
export default defineSchedule({
  cron: "0 16-19 * * 1-5",
```

---

## A15. `githubChannel` sandbox checkout cannot be disabled

Kind: buildable · Area: channels

**Gap.** The GitHub channel clones the triggering ref into the root sandbox on every turn
before the first model call. There is no option to turn this off for a project that owns its
Git access elsewhere.

**What eve says.** `docs/channels/github.mdx:120-122` (0.63.0 and HEAD): "every triggered turn
checks out the relevant ref into the sandbox." No opt-out documented; no statement that an
authored `turn.started` replaces the checkout. [V]

**What the project built.** An empty `turn.started` override that suppresses the default
handler. Since 2026-09-08 (pin 0.52.2). Own words: "The stock handler clones into
the root sandbox. Stations own all authenticated Git instead." [V]

**How it fails.** Silently: if eve moves the checkout to another event or a pre-turn step, the
clone returns and conflicts with the factory's brokered Git stations [I].

`agent/channels/github.ts:40-43`

```ts
  events:{
    // The stock handler clones into the root sandbox. Stations own all authenticated Git instead.
    async "turn.started"(){},
  },
```

---

## A16. Runtime value of `ctx.channel.kind` is undocumented

Kind: docs · Area: channels

**Gap.** Hooks receive `ctx.channel.kind` typed as `string`. The runtime value for Slack is
`"channel:slack"`, not `"slack"`; a hook that guesses the literal never fires.

**What eve says.** `docs/guides/hooks.md:53,63` (0.63.0): `readonly kind?: string`, with a
a pointer to narrow with `isChannel`. The literal appears only in eve tests
(`src/execution/runtime-context.test.ts:337`, `channel-address.test.ts:100`). [V]

**What the project built.** A guard that accepts both spellings. Since 2026-09-22
(pin 0.63.0): "recognize the runtime Slack channel kind." [V]

**How it fails.** Silently: a wrong literal means the usage footer hook never runs.

`agent/hooks/slack-admin-usage.ts:4`

```ts
const isSlackChannel = (kind: string | undefined) => kind === "channel:slack" || kind === "slack";
```

---

## A17. Sandbox fingerprint scope is undefined

Kind: docs · Area: sandbox

**Gap.** eve replaces a durable sandbox when its "source fingerprint" changes. The docs do not
say whether a change in a module the sandbox definition imports (here, the network policy)
counts, so the project cannot know whether a policy edit reaches sessions that reattach to an
existing sandbox.

**What eve says.** `docs/sandbox.mdx:290` (0.63.0): "A definition change to the authored sandbox
source, workspace seed content, or `revalidationKey` replaces the sandbox." Imports are not
mentioned. Actual fingerprint behavior was not tested [R]. [V for the doc]

**What the project built.** A hand-bumped `SANDBOX_REVALIDATION_KEY` (`<config-value>`)
with a comment instructing future editors to bump it on every policy change. Since 2026-08-04 (pin 0.30.6). [V]

**How it fails.** Silently: a policy edit without a key bump may leave durable sessions on a
sandbox with the old egress policy.

`agent/sandbox/sandbox.ts:19-22`

```ts
// Imported network-policy changes are not guaranteed to alter Eve's sandbox
// source fingerprint. Bump this key whenever the baseline policy changes so
// durable sessions cannot reattach to a sandbox that retained the old policy.
export const SANDBOX_REVALIDATION_KEY = "<config-value>";
```

---

## A18. `defineState` and context accessors cannot run outside an eve execution, so tests import the container from `dist`

Kind: buildable · Area: tooling

**Gap.** `eve/context` exports `defineState`, but a handle's `get()` and `update()` only work
inside an active eve execution, and eve exposes no public way to open one. A unit test for a
module that reads state has to construct eve's internal context container itself.

**What eve says.** `docs/guides/session-context.md:77` (0.63.0): "Its `get()` and `update()`
methods still require active eve execution." The public `eve/context` entry exports
`defineState`, `StateHandle`, and `SessionContext` types only (`src/public/context/index.ts:13-21`
at 0.63.0). The container lives at `src/context/container.ts` (`ContextContainer`,
`contextStorage`) and is not in the export map. No changelog entry through 0.68.0 adds a test
harness for it. [V]

**What the project built.** A test helper that resolves `eve/package.json`, appends
`dist/src/context/container.js` to its directory, dynamically imports it, and runs the test
body inside `contextStorage.run(new ContextContainer(), …)`. Used by three test files. Since
2026-09-22 (pin 0.63.0). Own words: "The pinned Eve runtime's real context container, used
only by local integration checks." [V]

**How it fails.** Loud: a moved or renamed `dist/src/context/container.js`, or a change to
`contextStorage`/`ContextContainer`, breaks the import at test time. The static-import scan
in this audit missed it because the path is assembled at runtime; any check that greps for
`from "eve/dist` will miss it the same way.

`tests/helpers/eve-context.ts:5-10`

```ts
// The pinned Eve runtime's real context container, used only by local integration checks.
const require = createRequire(import.meta.url);
const runtime = await import(pathToFileURL(join(dirname(require.resolve("eve/package.json")), "dist/src/context/container.js")).href);
export function withEveContext<T>(run: () => T): T {
  return runtime.contextStorage.run(new runtime.ContextContainer(), run);
}
```
