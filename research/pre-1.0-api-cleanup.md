---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-18"
---

# A smaller public surface for 1.0

After eve 1.0 releases, removing or reshaping anything eve exports needs a major version. This
plan proposes some targeted cleanup of these public exports before it gets hard to change things.

Today eve exports 2,005 names from 84 entry points (`eve`, `eve/client`, `eve/channels/slack`, etc).
The docs, the apps in this repository, and the e2e suites use about 450 of them. Most of
the rest weren't deliberately intended as API surface area. They got exported for one of three
reasons:

- **The same thing from several places.** `SessionView` can be imported from `eve/events` and
  from `eve/client`, and `isChannel` from `eve/channels` and from `eve/instrumentation`. It's
  not directly harmful but it's messy and confusing, especially as we have some cases where
  we deliberately export different things with the same name from different paths (e.g. `auto`).
- **Helpers eve uses internally.** `eve/channels/telegram` exports `editTelegramMessageText`,
  `renderTelegramInteraction`, and `TELEGRAM_HITL_CALLBACK_PREFIX` because the Telegram channel
  uses them, not because an app should.
- **Several shapes for one idea.** Six session commands (send, respond, cancel, clear, compact,
  reset) return about a dozen different result types between them, and "how did my request end"
  has five vocabularies across the client, MCP, and the CLI.

Some exported types also aren't eve's to promise. A signature that names another package's type
changes when that package does, and when the app hasn't installed the package, the type quietly
becomes `any`.

The plan cuts the surface to about 1,400 names, with one shape per idea and types eve owns.
Something left out can still be added after 1.0 if apps need it, but we can't take something out
retroactively.

## Background

A few terms used throughout, all from v27, the session-stream rewrite now in review (the stack
ending at #4855):

- A **session** is one durable conversation with an agent. It runs in **turns**: the agent reads
  new input, calls models and tools, and replies.
- A **delivery** is anything a session accepts: a message, an answer to a question, or a control
  such as cancel. Each has a `deliveryId`.
- The session's **stream** is an ordered log of **facts** about what happened, such as
  `delivery.admitted`, `turn.started`, `call.settled`, and `interaction.opened`.
- The **view** (`SessionView`) folds those facts into tables an app can read: calls,
  interactions, turns, and deliveries.
- An **interaction** is something waiting on a person: a question, a tool approval, a sign-in, or
  a budget request.

Changes to the stream and its facts land in the v27 PRs themselves, so v27 never ships a shape
that this plan changes. Everything else lands as PRs stacked on top of v27, released with 1.0.

## How to read this

[The main changes](#the-main-changes) are the ones that will have the most impact on user code.
Each explains what happens today, what changes, and why it's useful.

[Smaller changes](#smaller-changes) follow, collapsed.

## The main changes

### 1. Every command returns a delivery

**Today.** A session has six commands, and they report back in different ways depending on which
command you call and which handle you call it on. On the client, `send` returns a response you can
follow to the end of the turn. The controls return a status object that only says the command was
queued:

```ts
// eve/client
const response = await session.send("Summarize the thread");
const result = await response.result();

const cancelled = await session.cancel();
// { status: "accepted", sessionId } | { status: "no_active_turn" }
const reset = await session.reset();
// { status: "reset", previousSessionId } | { status: "no_active_session" }
```

In a channel route, the same commands return other shapes. Sending through `from()` returns a
session handle; sending on that handle returns a status union you must check, with an optional
`deliveryId`:

```ts
// a channel route
const session = await from(threadId).send(text, { auth }); // a Session handle
const stream = await session.getEventStream();

const next = await session.send(followUp, { auth });
// { status: "accepted", sessionId, deliveryId? } | { status: "session_not_active", retryable? }
```

That's about a dozen result types, each with its own way of saying nothing happened
(`no_active_turn`, `no_active_session`, `session_not_active`). And once a cancel or reset is
accepted, nothing tells you when it actually took effect.

**The change.** Every command, on every handle, returns a `Delivery`: an id, the session it
went to, and a way to follow it to the end.

```ts
interface Delivery<TOutput = unknown> extends AsyncIterable<SessionStreamEvent> {
  readonly sessionId: string;
  readonly deliveryId: string;
  result(): Promise<DeliveryResult<TOutput>>;
}
```

```ts
const delivery = await session.send("Summarize the thread");
for await (const event of delivery) render(event); // or just await the result
const { status, reply } = await delivery.result();

const cancel = await session.cancel();
await cancel.result(); // resolves once the turn has actually stopped
```

A session that can't accept a command (it has ended, or its inbox isn't ready yet) throws
`SessionNotActiveError`, with `retryable` set when trying again can help. The client already
throws in this situation, and retries when the inbox isn't ready; channel handles now behave the
same way.

**Why it's useful.**

- The same code works on the client, in a channel route, and in a schedule.
- Controls become followable. A route that resets a session and then starts a new one can wait for
  the reset to finish instead of racing it.
- Failure has one path. Today a channel handle throws for a stranded session but returns a status
  for an ended one, and a caller that skips the status check believes a message was sent when it
  wasn't.
- Every command has a `deliveryId`, so its effect can be looked up in the view, which is what
  [request statuses](#2-request-statuses-describe-the-request) build on.

<details>
<summary>Session handles, streams, and options</summary>

**Two handle shapes.** Handles that can only read a session (`eve/server`'s `sessions.attach(id)`
and a client's child-agent handle) are a `SessionReader`: an `id` and `stream()`. Handles that can
also send are `SessionOperations`, and they exist only where an authenticated caller is already in
hand: channel routes, schedules, and the client. No handle gains a power it doesn't have today.
`ServerSession` is removed. The client's `ClientSession`, `ClientAgentSession`, and
`ClientSessions` are exported as types only: `new Client()` and its methods create them, and their
constructors take internal state.

**One way to read.** Every handle reads with `stream()`, an `AsyncIterable` of events.
`getEventStream()`, `getLineStream()`, and `getChildBinding()` are removed. The first read checks the
session, so a route can await the first event before it sends its HTTP response and still answer
a stranded session with an error status.

Every `stream()` takes one `SessionStreamOptions`: `startIndex`, `follow`, and `signal`, plus
`streamReconnectPolicy` on the client. `startIndex` is a line, the `line` of an event's
`meta.position`, not an event count: one line holds every fact of a commit, and a reader resumes
by line. Today three option types describe it, and some of their docs say it counts events.

**Channel sends.** `ChannelSource.send()` returns the `Delivery` rather than a handle;
`attachSession(delivery.sessionId)` makes a handle without any I/O. A delivery's fields are plain
properties, so `Response.json(await from(id).cancel())` returns the receipt as JSON.

**Options.** Every send accepts `outputSchema` and `turnPolicy`; each side adds what only it
knows:

- Server-side sends (channels) take `auth`, typed `state`, `context` (kept in history), and
  `title` when the send creates the session.
- Client-side sends (the client, the frontend store, the hooks) take `clientContext` (shown to the
  model for one turn only), `signal`, `headers`, and `streamReconnectPolicy`.
- Workflow `ctx.agent().send()` takes `outputSchema` and `signal`; a schedule's `to().send` takes
  `auth` and `turnPolicy`.
- `respond` takes the same options as `send` on its side, without `turnPolicy` or `title`.
- `callback` and `initiatorAuth` go.

**Typed output.** `TOutput` is inferred from `outputSchema` wherever eve accepts a Standard Schema
(the client, the frontend store and hooks, workflows). Server-side sends take a JSON Schema
object, so their `data` is `unknown`.

**Names.** The frontend store's local "start over" becomes `newSession()`, so `reset()` means the
same server-side retire on every handle. `eve/context`'s read-only `Session` is renamed
`SessionInfo`, since it isn't a handle, and it is the type of `ctx.session`: `id`, `auth`, `turn`,
`parent`, `schedule`, and `predecessor`.

</details>

### 2. Request statuses describe the request

**Today.** The status most apps read is `MessageResult.status`, which describes the session's
status, not the message's:

```ts
const { status } = await response.result();
// "waiting":   the turn completed, OR it was cancelled, OR it paused for an approval
// "completed": the whole session ended
// "failed":    the turn or the session failed
```

To find out whether your message actually got an answer, you have to inspect `interactions` and
the stream. Other surfaces answer the same question in their own words: MCP's `agent_*` tools
report `working`, `input_required`, `authorization_required`, and so on, and `eve invoke` reports
`running`, `input-required`, `ready`, `failed`, and `authentication-required`.

**The change.** One status type describes how a request ended, and every surface uses it:

```ts
type RequestStatus = "working" | "awaiting-input" | "completed" | "failed" | "cancelled";
```

```ts
const { status, sessionEnded } = await delivery.result();
if (status === "awaiting-input") showPendingApprovals();
if (status === "completed") showReply();
if (sessionEnded) startOver();
```

`eve/events` exports the selector that computes it, `requestStatus(view, deliveryId)`, so a
custom UI derives the same answer from the view. MCP keeps its wire names but drops
`authorization_required`, since a sign-in is an interaction like any other; `eve invoke` uses the
same five values.

`DeliveryResult.status` excludes `"working"`: a settled result cannot still be making progress.
The live `requestStatus(view, deliveryId)` selector retains that value.

**Why it's useful.**

- Apps get the answer to the question they actually ask ("what happened to my message?") without
  reading the stream.
- One vocabulary everywhere, so code and docs for one surface apply to the others.

**The migration risk.** Code that compares with `"waiting"` stops compiling, so those spots are
easy to find. `"completed"` is in both vocabularies with different meanings: today it means the
session ended, afterwards that the request completed. The upgrade guide calls this out, and
`sessionEnded` carries the old meaning.

### 3. One import path per name

**Today.** 263 exported names are the same symbol exported from a second (or third) entry point.
Most apps import from whichever path their editor suggested first:

```ts
import type { SessionStarted, SessionView } from "eve/client";
import { isChannel } from "eve/instrumentation";
```

Both work, but `SessionStarted` and `SessionView` belong to `eve/events`, and `isChannel` to
`eve/channels`. The biggest source is `eve/client`, which re-exports all 175 type names of
`eve/events`. That made sense in v26, when the stream types lived in the server package and a
browser app couldn't import them safely; `eve/events` has no runtime dependencies now.

**The change.** Each name is exported from the one entry point whose docs describe it:

```ts
import type { SessionStarted, SessionView } from "eve/events";
import type { SessionStreamEvent } from "eve/client";
import { isChannel } from "eve/channels";
```

**Why it's useful.** We currently intentionally have parts of our public API that export
the same name with different definitions from different paths. That's totally fine, but
if we also sometimes export the same object from different paths, it's hard to know when
a symbol is identical or not.

**One name, one meaning.** The deliberate pairs are the same idea for different slots or
directions: `defineDynamic` per slot, `auto` for models and approvals, `byPrincipal` for memory
and schedules, `withEve` for Next.js and Vercel, and `vercelOidc` for sending and for verifying a
Vercel OIDC token. The other collisions go:

- `eve/tools/grep` and the code extension's `grep` are two tools with different inputs: the
  extension's adds output modes (`files_with_matches`, `content`, `count`) and limits rows rather
  than matches per file. The built-in takes the extension's inputs, and the extension contributes
  the built-in.
- `gh` and `GitHubLeaseBroker` exist twice only for the deprecated `code({ github })`, and go
  with it.
- `eve/events` and `eve/instrumentation` declare `JsonValue` separately; one declaration remains.

<details>
<summary>The other duplicates</summary>

- `isChannel` and the `InstrumentationChannel*` types leave `eve/instrumentation`, where a comment
  has kept them "so existing imports continue to work" since the first commit.
- `SessionContext` comes from `eve/context` only; `JsonValue` and the trace-policy types from one
  entry each; assertion types from `eve/evals` only. Three copies of `RuntimeIdentity` and
  `TraceContext` become one each.
- `ToolStub` leaves `eve/client` (it's documented under evals). `defaultWebSearch`, the web-search
  tool's default export under a third name, goes. The bare `eve/self-modification` entry, the
  same file as `eve/self-modification/local`, goes.
- The Slack, Telegram, Teams, and Discord entries stop re-exporting the AI SDK's `ModelMessage`:
  none of their APIs uses it.

</details>

### 4. Internal helpers stay internal

**Today.** Two groups hold most of the names that nothing outside eve uses.

`eve/setup` (77 names) and `eve/setup/scaffold` (54) are the internals of the `eve` CLI's setup
wizard. Nothing outside the eve repository imports `eve/setup`. Known downstream scaffold consumers use
five exports to generate projects.

The ten platform channel entries export 559 names. Next to what an app needs (the channel
factory, its config and state types, the handler context), they export the channel's own
plumbing: typed wrappers for each platform API call, request signing and verification, how
prompts are rendered, and the constants the channel puts in callback payloads.

```ts
import {
  telegramChannel, // the channel: an app needs this
  editTelegramMessageText, // a wrapper around one Bot API method
  renderTelegramInteraction, // how the channel draws an approval prompt
  TELEGRAM_HITL_CALLBACK_PREFIX, // part of the channel's callback encoding
} from "eve/channels/telegram";
```

**The change.** `eve/setup` stops being exported, and the scaffold moves to
`eve/internal/scaffold`, exporting only the downstream scaffolding contract. Each platform entry exports the
channel factory, its default auth and continuation-token helpers, and the types an app writes:
config, credentials, state, handler context, handle, thread, and payloads. Types that only a
removed helper used, such as each platform's `*VerifyOptions`, leave with it. Inside a handler,
`ctx.channel.telegram` (and its equivalent on every platform) already gives raw API access.

Helpers stay public when they're documented or useful outside a handler: Slack's `callSlackApi`,
`resolveSlackBotToken`, `postCompletedSlackReply`, `loadThreadContextMessages`, its renderer,
answer helpers, and card builders; Linear's `callLinearGraphQL` and `createLinearAgentActivity`;
and the Chat SDK channel's `messageContentOf` and `isNotImplemented`.

**Why it's useful.** Every exported helper is a signature eve can't change without a major
version, and platform plumbing is exactly what changes most: when Telegram's Bot API adds a
parameter or Slack changes how it signs requests, eve should be free to follow. Raw-call helpers
for Telegram, Teams, Discord, Twilio, and GitHub can come back if apps ask for them.

<details>
<summary>Smaller internals</summary>

- **Built-in extensions.** Each exports the extension, its config types, its tools, and its
  documented sandbox helpers. `eve/extensions/code/prwatch` (27 names: pull-request watch state
  transitions, tokens, and zod schemas) goes internal. So do the constants and prompt text that
  `eve/extensions/git/sandbox` exports only for the code extension (`GH_SIGNED_COMMIT_*`,
  `GH_TOOL_DESCRIPTION`, `GITHUB_TOOLING_PATHS`, `githubInstructions`, `prSkill*`, and
  `defineGhTool`) and the `*_REVALIDATION_KEY` constants. What one built-in extension shares with
  another moves to `eve/internal/*`.
- **Loader internals.** Internal recognition details can leave the public API, but disabled-marker
  types and their guards stay: `DisabledToolSentinel`, `DisabledRouteSentinel`, and
  `InstrumentationDisabled`. Public factories return these values; hiding their names creates
  declaration-portability workarounds rather than a simpler API. `isScheduleAuth` also stays.
  Guards only eve's loader calls leave: `isInstrumentationProvider`, `isOtelDeclaration`,
  `isOtelIntegration`, and `serializeModelInputSchema`.
- **Authoring types stay public.** Keep the named judge, mock-model, and approval request/response
  types used to write shared helpers and reusable values. This includes `JudgeBatch`, `JudgeInput`,
  `JudgeContext`, `ScoreInput`, the `MockModel*` types, and `ApprovalRequest`, `ApprovalResponse`,
  `ApprovalResponseAuth`, and `ApprovalResponseSession`. Removing duplicate export homes still
  applies; hiding useful names solely to reduce the count does not.
- **`eve/events`.** An explicit export list replaces the `export *` lines. Line encoding and its
  limits, `foldLine` / `foldLines`, `viewOfEvents`, `foldReceivedEvent`, `copyView`, the retention
  options, and the 14 fact zod schemas stay internal (the schemas put eve's vendored zod types
  into `.d.ts` files). So do the transport records and line types (`HEARTBEAT_RECORD`,
  `LEASE_ENDED_RECORD`, `STREAM_ENDED_RECORD`, `classifyRecord`, `isStoredLine`, `StoredLine`,
  `CommitLine`, `ProgressLine`, `TransportRecord`, `ReadRecord`, `PositionMarker`): the streaming
  docs describe the format, and `eve/client` reads it. The progress catalog and the fold's own
  guards (`PROGRESS_CATALOG`, `isFactType`, `isProgressType`, `isTerminalType`, `isKnownOutcome`,
  `contentPhase`) go too; `FACT_CATALOG` and its descriptor types stay. `foldEvents`,
  `emptySessionView`, and `emptyPreviews` stay as the public way to fold a stream, and components
  read the frontend store's `view` rather than folding themselves.
- **Built-in tools.** The 12 public `…_INPUT_SCHEMA` / `…_OUTPUT_SCHEMA` constants. The documented way to
  customize a built-in tool, spreading it (`{ ...bash, description }`), already copies its
  schemas.
- **Small helpers.** `escapeAuthChallengeParameter` and `readOAuthResourceOptions` (only the MCP
  channel calls them), `ResolvedStreamReconnectPolicy`, `EVE_NEXT_SERVICE_PREFIX`, and the
  one-line `createDataUrlFilePart` / `createTextWithFileContent` builders.
- **Legacy self-modification.** The pre-#3501 `/config` entry and the legacy-scaffold migration
  go. `/agent` and `/sandbox` move under `eve/internal/self-modification/`, since one package
  uses them.

</details>

### 5. Instrumentation events match the stream

**Today.** An instrumentation provider subscribes to lifecycle events by name. Some already use
the stream's facts (`turn.settled`, `call.settled`, `interaction.opened`), but the rest still have
one event per ending, and each event has its own exported interface:

```ts
defineInstrumentation({
  events: {
    "step.attempt.completed": (event: InstrumentationStepAttemptCompletedEvent) => record(event),
    "step.attempt.failed": (event: InstrumentationStepAttemptFailedEvent) => record(event),
    "channel.delivery.completed": (event) => attribute(event),
  },
});
```

**The change.** The remaining events take the stream's shape, one start and one `settled` with an
`outcome`, and one generic type describes all of them, as `HookEvent<K>` does for hooks:

```ts
defineInstrumentation({
  events: {
    "model.settled": (event: InstrumentationEvent<"model.settled">) => record(event), // event.outcome
    "delivery.settled": (event) => attribute(event),
  },
});
```

The provider's own types take the hooks' names: `InstrumentationDefinition`,
`InstrumentationEvents`, `InstrumentationHandler<K>`, and `InstrumentationContext` replace
`ProviderDefinition`, `ProviderEvents`, the bare `Handler`, and `ProviderContext`.

**Why it's useful.** A provider that already handles the stream's facts handles these the same
way, and the instrumentation entry goes from about 100 exported names to about 40. The built-in
OpenTelemetry provider keeps its span names and trace schema 4, so dashboards built on its spans
don't change; only hand-written providers update their event names.

<details>
<summary>Every renamed event and type</summary>

- `channel.delivery.started`, `.cancelled`, `.completed`, and `.failed` become
  `delivery.consumed` and `delivery.settled { outcome }`. A turn that pauses for a person settles
  its delivery as `awaiting-input`, and the work after the answer belongs to the answer's delivery.
- `step.attempt.started`, `.completed`, and `.failed` become `model.started`, `model.retried`, and
  `model.settled { outcome }`.
- `step.attempt.metadata` becomes `providerMetadata` on `model.call.settled`.
- `model.call.completed` and `.failed` become `model.call.settled { outcome }`.
- `memory.operation.completed` and `.failed` become `memory.operation.settled { outcome }`.
- `InstrumentationEvent<K>` replaces about 18 named event interfaces and 15 aliases for their
  parts.
- `ProviderState` and `ProviderSetupContext` become `InstrumentationState` and
  `InstrumentationSetupContext`; `EvaluationRef` becomes an inline `evaluation?: { runId }`.
- Events and `runtimeContext` inputs say where they are the same way, with the nested `session`,
  `turn`, and `run` rather than `InstrumentationScope`'s flat ids. `InstrumentationParentLineage`
  becomes `SessionParent`, and `InstrumentationEnvironment` and `ConversationEnvironment` become
  one type.

</details>

### 6. eve owns the types in its signatures

**Today.** `ai` is a peer dependency, so the AI SDK types in eve's public signatures are whatever
version the app installed. A tool's `ctx.messages`, for example, is the AI SDK's `ModelMessage`:

```ts
// eve/tools, today
import type { ModelMessage } from "ai";

interface ToolContext {
  readonly messages: readonly ModelMessage[];
}
```

If an AI SDK release changes `ModelMessage`, eve's API changes with it, in a release eve didn't
make and may not handle. Some signatures follow APIs the AI SDK marks experimental: `decide`
takes `Parameters<typeof experimental_decide>[0]`, test-only `_internal` option included, and
both `auto()`s take `Experimental_DecisionModel`. That API has already been renamed once, from
`experimental_evaluate`.

It's worse when a type comes from a package the app doesn't have. eve bundles zod, the Chat SDK,
and the Twilio and Linq adapters, but their bundled declarations point back at the real packages,
or at files eve doesn't ship. An app without them that skips library checks, as most templates
do, gets `any` with no error:

```ts
import type { AgentInfoResult } from "eve/client";

declare const info: AgentInfoResult; // any: derived from a zod schema, and the app has no zod
```

In a project with only `ai` and `@types/node` installed, 43 exported types are `any` or have
`any` fields, among them every `AgentInfo*` type, `HealthResult`, Slack's card types, and
Twilio's webhook URL. The framework entries also import `next`, `vite`, `vue`, Nuxt, and their
frameworks' runtimes without declaring them.

**The change.** eve defines its own `HistoryMessage`, a copy of `ModelMessage`'s structure (about
300 lines of types), exported from `eve/context`. Tool, memory, and dynamic contexts use it. If the
SDK's shape drifts, eve converts at runtime and its own type stays put. `SandboxSession` and its
option and result types get the same treatment, copied from the AI SDK's experimental
`Experimental_SandboxSession`. Instrumentation's model input becomes `unknown`, documented as the
provider's request messages.

The decision API gets the same treatment. `eve/ai` defines `DecisionModel`, `DecisionQuestion`,
`DecisionAnswer`, and `DecisionResult`, copied from the AI SDK's current shapes, and `decide`,
both `auto()`s, and eval judges use them:

```ts
const { answers } = await decide({
  state: ticket,
  questions: { urgent: { type: "boolean", instructions: "Does this need a reply today?" } },
  signal: ctx.abortSignal,
});
```

`decide` takes `model`, `state`, `questions`, `maxRetries`, and `signal`, and returns `answers`
and `usage`. A model is an ID or any provider object with a `provider` and a `modelId`, so a
provider on a newer model specification still typechecks. It must expose a `doDecide` or
`doEvaluate` implementation; identity fields alone are not a usable model. The AI SDK still validates, retries,
and resolves models at runtime, as [evaluation model routing](./jev-decision-models.md) set out.
`AgentReasoningDefinition` lists its levels rather than deriving them from the AI SDK.

No public type names a package the app may not have:

- Client types derived from zod schemas become interfaces. The schemas stay internal, as the
  fact schemas do, and eve's build checks them against the interfaces.
- Slack's card types become eve's copy of the Chat SDK's card element types. They're plain data
  with no classes, so a copy is safe, and a Slack app doesn't need `chat` installed.
- Twilio's webhook types, `@vercel/sandbox`'s `Drive` class and network-policy types, and
  `@vercel/otel`'s `*OrName` option types become eve-owned or go, as do the `EveNext*` aliases of
  Next.js's config.
- `eve/workflow-modules` declares the part of the Workflow SDK that authored workflows use
  (`createHook`, `createWebhook`, `sleep`, `FatalError`, and `getWorkflowMetadata` from `workflow`;
  `start`, `getRun`, `resumeHook`, and `getHookByToken` from `workflow/api`) rather than all of its
  about 70 names, which include a second `defineHook` and a legacy `fetch`.
- Packages the framework entries import become optional peers with version ranges: `react`,
  `vue`, `svelte`, `next`, `vite`, `@nuxt/kit`, `@nuxt/schema`, and `@vercel/connect`. Bundled
  declarations ship every file they import.

**Why it's useful.** eve's API changes only when eve releases a change, and an app's types never
silently become `any`. The cost is about 500 lines of types to maintain.

Two exceptions stay on purpose. OpenTelemetry's `SpanExporter` and `SpanProcessor` stay, since an
OpenTelemetry integration implements them by definition. The Chat SDK channel's types stay the
app's own `chat`: it passes the app's adapters to Chat SDK classes, which need one identity.

### 7. Remembering approvals with `once({ key })`

A tool's `approval` policy decides whether a call runs, waits for a person, or is refused.

**Today.** `once()` asks for approval the first time a tool is called, then stops asking for the
rest of the session. To remember an approval per input instead (once per environment, say), a
tool sets `approvalKey` to name the grant eve saves, and writes its own policy that looks the
grant up in `approvedTools`:

```ts
export default defineTool({
  approvalKey: ({ environment }) => `deploy:${environment}`,
  approval: ({ approvedTools, toolInput }) =>
    approvedTools.has(`deploy:${toolInput?.environment}`) ? "not-applicable" : "user-approval",
  // …
});
```

The key is built twice, and the two strings have to match: a typo means the approval is never
remembered, and nothing reports it. `once()` can't help, because it only checks the bare tool
name, so a tool that sets `approvalKey` and uses `once()` asks every time.

**The change.** The key moves into `once()`, and `approvalKey` and `approvedTools` are removed:

```ts
export default defineTool({
  approval: once({ key: (input) => input.environment }),
  // …
});
```

`once()` without a key works as it does today, and policies keep every return value they have
now. A call that runs because a policy or a remembered approval cleared it records that on the
stream.

**Why it's useful.**

- The key is written once, next to the policy that reads it.
- Connection tools get keyed approvals too. Today they can't set a key.
- An audit can tell a call that needed no approval from one that a policy or an earlier approval
  cleared.

<details>
<summary>How grants work, and what the old setup could do that this doesn't</summary>

**Grants.** A grant is scoped to its tool, so two tools that both key by environment can't clear
each other. eve reads the key when `once` asks, so `once` also works inside a custom policy:

```ts
const perEnvironment = once<DeployInput>({ key: (input) => input.environment });
approval: (ctx) => (ctx.toolInput?.environment === "dev" ? "not-applicable" : perEnvironment(ctx)),
```

A call cleared by a policy records `clearedBy: { policy }` on its `call.started` fact, and one
cleared by a grant records `clearedBy: { grant: { interactionId } }`, pointing at the approval.

**What goes.** Three things `approvedTools` allowed:

- Sharing a grant between tools, such as a rollback tool that skips its prompt once a deploy was
  approved.
- Grants from approvals `once` didn't ask for. Today any approval adds a grant; now only a prompt
  `once` asked does. a downstream connection asks on its own and then checks its
  grant; it moves to returning `once()`'s result where it asks today.
- Logic over every grant in the session, such as "if any write tool was approved, let reads
  through".

An authored tool can still do all three with public APIs. `ctx.approval` is set in `execute` only
when a person approved the call, so the tool can record approvals in state and its policy can
read them:

```ts
const approvedEnvironments = defineState("deploy.approved-environments", (): string[] => []);

export default defineTool({
  approval: ({ toolInput }) =>
    toolInput !== undefined && approvedEnvironments.get().includes(toolInput.environment)
      ? { type: "approved", reason: `Approved earlier for ${toolInput.environment}.` }
      : "user-approval",
  async execute(input, ctx) {
    if (ctx.approval !== undefined) {
      approvedEnvironments.update((envs) => [...envs, input.environment]);
    }
    return deploy(input);
  },
});
```

Connection tools have no `execute`, so sharing grants between them would need a hook. A shared
scope such as `once({ key, shared: "prod-deploys" })` can be added later without a break if
anyone needs it.

</details>

## Smaller changes

<details>
<summary>A channel's <code>deliver()</code> payload gets a type</summary>

A channel's `deliver()` hook can adjust each delivery before the agent sees it. Today it receives
an open bag (`[key: string]: unknown`) that mixes the documented per-delivery `state` with eve's
internal keys, so a channel casts what it reads, and it has to return the harness's internal
`StepInput`:

```ts
// today: Teams merges per-delivery state into channel state
deliver(payload, channel) {
  const state = payload.state as Partial<TeamsChannelState> | undefined;
  const cards = state?.pendingPromptCards;
  if (cards !== undefined) {
    channel.state.pendingPromptCards = { ...cards, ...channel.state.pendingPromptCards };
  }
  return defaultDeliverResult(payload);
},
```

One typed payload replaces the five overlapping internal types behind it, and returning nothing
delivers it unchanged:

```ts
interface ChannelDelivery<TState = undefined> {
  readonly message?: MessageContent;
  readonly answers?: readonly Answer[];
  readonly context?: readonly string[];
  readonly outputSchema?: JsonObject;
  readonly state?: Partial<TState>;
}

deliver(payload, channel) {
  const cards = payload.state?.pendingPromptCards; // typed by the channel's state
  if (cards !== undefined) {
    channel.state.pendingPromptCards = { ...cards, ...channel.state.pendingPromptCards };
  }
},
```

eve's internal keys move off the payload, so `deliver()` can't depend on them by accident.

</details>

<details>
<summary>Hooks see a channel's real identity</summary>

Every authored channel has an identity, `channel:<name>` (from `agent/channels/<name>.ts`), and
`isChannel()` compares against it. Instrumentation sees that identity, but hooks and dynamic
resolvers see something else: the kind of the channel's _adapter_, the key eve saves with a
session to rebuild its channel after a restart. A channel with custom behavior saves as
`channel:<name>`, but a channel that only defines routes shares eve's HTTP adapter and saves as
`"http"`. So in a hook:

```ts
// agent/channels/support.ts defines routes only
if (isChannel(ctx.channel, supportChannel)) await notifySupport(event); // never true today
```

The fix keeps the adapter kind as a private storage key and gives hooks the channel's identity
from the delivery, which already records which channel it came through. The `delivery.admitted`
fact's `source.channel` records the same identity. The alternative, saving every channel under
its own name, would strand a route-only channel's sessions whenever its file is renamed.

`kindHint`, which registration always overwrites, and the deprecated `metadata().audience`
projector get removed.

The identity gets one type, too. Hooks, dynamic resolvers, memory and schedule scopes,
self-modification authorization, and instrumentation each declare their own `channel` today, with
`kind` a plain string in most and `metadata` in some. One `ChannelInfo` from `eve/channels`
replaces them:

```ts
type ChannelKind = `channel:${string}` | "http" | "schedule" | "subagent" | "unknown";

interface ChannelInfo<TMetadata = Readonly<Record<string, unknown>>> {
  readonly kind: ChannelKind;
  readonly continuationToken?: string;
  readonly metadata: TMetadata;
}
```

`kind` is always set, and `isChannel(ctx.channel, supportChannel)` narrows `metadata` to that
channel's in every context. Dynamic connection resolvers keep only `kind`, as now. The five
`InstrumentationChannel*` types become `ChannelInfo` and `ChannelKind`.

</details>

<details>
<summary>Memory and dynamic resolver keys say what they do</summary>

A memory provider's keys mix the live `turn.started` event name with three retired v26 names.
None is really a subscription to that event:

```ts
// today
defineMemoryProvider({
  recall: { "turn.started": recall, "compaction.completed": recallAfterCompaction },
  capture: { "compaction.requested": saveBeforeCompaction, "turn.completed": saveTurn },
});

// after
defineMemoryProvider({
  recall: { beforeTurn: recall, afterCompaction: recallAfterCompaction },
  capture: { beforeCompaction: saveBeforeCompaction, afterTurn: saveTurn },
});
```

Recall after compaction stays. Reactions (#4616) moves recalled memory out of the conversation
history, but a provider still needs a hook after compaction, to bring back what the summary lost
and to prune recall that piled up. `afterCompaction` returns the full set of recalled memory for
its slot, replacing what was there
([proposal on #4616](https://github.com/vercel/eve/pull/4616#issuecomment-6202534510)). This lands
with #4616.

Dynamic resolvers' keys get the same treatment, without waiting for #4616. Their
`session.started`, `turn.started`, and `step.started` are change points with a private payload,
and `step.started` isn't a fact at all. They become `beforeSession`, `beforeTurn`, and
`beforeModel`, and a handler receives the typed change point rather than `unknown`. `eve/tools`
and `eve/skills` get slot-typed `defineDynamic`s, as instructions and connections have.

</details>

<details>
<summary>The frontend store's snapshot is flat</summary>

`useEveAgent` (and its Vue and Svelte equivalents) returns a snapshot of the conversation. Today
the conversation sits under `data`, and the status splits "busy" in two, so most apps check both:

```ts
// today
const agent = useEveAgent();
const messages = agent.data.messages;
const isBusy = agent.status === "submitted" || agent.status === "streaming";

// after
const agent = useEveAgent();
const messages = agent.messages;
const isBusy = agent.status === "busy";
```

The snapshot is `view`, `previews`, `messages`, `agents`, `events`, `session`, `status`, and
`error`. `status` is `idle`, `busy`, or `resuming`; an error is in `error` rather than a status.
The callbacks (`onEvent`, `onError`, `onFinish`, `onSessionChange`, `prepareSend`) all stay;
`prepareSend` gets a public type. Two doc fixes come with it: the persistence example saves when
`events` or `session` change rather than in `onFinish`, which doesn't fire when a turn pauses for a
person, and the personal-agent template resets its counters on `turn.started` instead of watching
for `"submitted"`. React's hook returns `UseEveAgentReturn`, as Vue's and Svelte's do, rather
than `UseEveAgentHelpers`.

</details>

<details>
<summary>Eval names follow v27</summary>

Eval assertions keep their shape and options. Four names still describe calls in v26 terms, and
take v27's:

- `loadedSkill` becomes `calledSkill`, and `calledSubagent` becomes `calledAgent`, so every kind
  of call reads like `calledTool`.
- `noFailedActions` becomes `noFailedCalls`, and `turn.parked()` becomes `turn.awaitingInput()`:
  v27 has calls and interactions, not actions and parking.

`calledTool`, `notCalledTool`, `usedNoTools`, `maxToolCalls`, `toolOrder`, `requireToolCall`, and
`waitForToolCall` don't change.

Attaching to an existing session changes too. `t.target.attachSession(id)` reads one turn before it
returns, and `watchTurn` is a separate call; both become methods of an attached session, which
tracks its own position in the stream:

```ts
const session = t.target.attach(id); // no I/O
const turn = await session.nextTurn();
const live = session.watch();
```

Eval sessions, turns, and results also carry the `view`, so `toolCallsOf` goes (`view.calls` has
every call), and results report `RequestStatus`, `sessionEnded`, `reply`, and `data`. Reporters
rename `eveParked` to `eveAwaitingInput`, add `eveSessionEnded`, and name agent-call metrics for
agents; saved queries on the old names need a one-time edit.

</details>

<details>
<summary>Interactions and tool parts</summary>

**Interactions.** Three types describe a pending question or approval, depending on where you read
it: `AskedInteraction` from a message result, `ReaderInteraction` from the view, and
`ConversationInteraction` from the frontend store. One `Interaction` type, from
`interaction(view, id)`, replaces them. Approval and budget prompts use exported `approve` and
`deny` option ids.

</details>

<details>
<summary>Other consolidations</summary>

- **Connections.** One ownership field, `principalType: "app" | "user"`, replaces
  `credentialOwner`. This reverses the deprecation at #4855, where `credentialOwner` was preferred. `ConnectionAuthProvider` merges into `AuthorizationDefinition`.
- **Sandbox.** `RuntimeSandboxSession` and `RuntimeSandboxSessionFor<S>` merge into one
  `RuntimeSandboxSession<S = SandboxSession>`. The eight method option types stay, since provider
  authors implement them and wrappers build them as values.
- **Naming.** `agent` names calls, tasks, and wire facts; `subagent` names only local definitions.
  So `followSubagents` becomes `followAgents`.
- **Approval types.** The tool-only `ToolApproval` types merge into `Approval` and
  `ApprovalConfiguration`, which gain an optional `prompt`.
- **Channel CORS.** `EveChannelCors` merges into `ChannelCors`, which also accepts a single origin
  string.
- **Wire spelling.** Interaction options use `label` rather than `title`, and settled reasons are
  kebab-case.

</details>

<details>
<summary>Principals have one spelling</summary>

Five public shapes describe who's calling, and they spell the principal's type three ways and its
id two ways:

| Where                                             | Type            | Id            |
| ------------------------------------------------- | --------------- | ------------- |
| `ctx.session.auth.current` (`SessionAuthContext`) | `principalType` | `principalId` |
| A connection's callbacks (`ConnectionPrincipal`)  | `type`          | `id`          |
| `delivery.admitted`'s `principal`                 | `type`          | `id`          |
| An audience callback's `caller.principal`         | `kind`          | (none)        |
| A schedule's creator reference                    | `type`          | `principalId` |

The projections differ on purpose: an audience callback never sees identifiers, the stream records
the least it needs, and a connection's user id is normalized for its token cache. Their spelling
shouldn't. Each becomes a subset of `SessionAuthContext`, with its names: `delivery.admitted`'s
`principal` is `{ principalType, principalId, issuer? }`, `ConnectionPrincipal` is
`{ principalType: "app" }` or `{ principalType: "user", principalId, issuer?, attributes? }`, and
the audience caller and schedule reference name their type `principalType`.

`@vercel/connect/eve` reads `principal.type` and `principal.id`, and hands `ConnectionPrincipal` to
its `principalToSubject` and `createSubject` callbacks. The connection rename ships with a
Connect release that reads the new names, and eve's optional peer range on `@vercel/connect`
requires it, so a stale Connect fails at install rather than resolving the wrong subject.

`principalType` is typed
`"user" | "service" | "runtime" | "anonymous" | "local-dev" | (string & {})`, so editors suggest
eve's values and custom route auth can still add its own. A connection's
`principalType: "app" | "user"` keeps its name: `"user"` requires a caller whose `principalType`
is `"user"`, and `"app"` is the agent's own credential, never a kind of caller.

</details>

<details>
<summary>Deprecated aliases go</summary>

Pre-1.0, a deprecated name has no reason to ship:

| Goes                                                                 | Use instead                     |
| -------------------------------------------------------------------- | ------------------------------- |
| `experimental_chatgpt` from `eve/models/openai`                      | `chatgpt`                       |
| `computer_use` and `gh` from `eve/extensions/code/tools`             | The computer-use and git tools  |
| The computer-use and GitHub helpers in `eve/extensions/code/sandbox` | Their own extensions' `sandbox` |
| `code({ github })` and the code extension's `GitHubLeaseBroker`      | `git({ github })`               |
| `AudienceInput`, its `auth`, and `AudiencePrincipal`                 | `AudienceContext` and `caller`  |
| `defineInstructions({ markdown })`                                   | `{ content }`                   |
| `defineExtension`'s unused second argument                           | Nothing                         |
| `eve/workflow-modules`' legacy `fetch`                               | Nothing                         |

</details>

<details>
<summary>Names follow one convention</summary>

- **Experimental.** An experimental module lives under `eve/experimental/*`, and an experimental
  option in a stable definition goes under `experimental: {}`, as
  `defineAgent({ experimental: { workflow } })` does. The `Experimental_` type prefix and the
  `experimental_` field prefix go: an MCP connection's `experimental_events` becomes
  `experimental: { events }`, and the `Experimental_ConnectionEvent*` types move to
  `eve/experimental/connections`.
- **Built-in extensions.** All of them live under `eve/extensions/*`: `eve/computer-use` becomes
  `eve/extensions/computer-use`, and `eve/self-modification/{local,remote}` becomes
  `eve/extensions/self-modification/{local,remote}`.
- **Built-in tools.** A tool without options exports the tool itself, named and as the default,
  as `bash` does, so `sleep`, `noReply`, and `askQuestion` stop being zero-argument factories. A
  tool with options exports only its factory: `eve/tools/web_search` stops default-exporting a
  preconfigured tool, so `webSearch` names one thing. `eve/tools/agent-router` becomes
  `eve/tools/agent_router`, like the other tool paths.
- **Factories.** Factories are camelCase functions. PascalCase is for namespaces of several
  constructors, such as `VercelSandbox.environment()` and `DockerSandbox.image()`. The eval
  reporters, which are single functions, become `consoleReporter()`, `junitReporter()`,
  `braintrustReporter()`, and `datadogReporter()`.
- **Channels.** Every channel's options type is `*ChannelConfig`, so `EveChannelInput` and
  `McpChannelInput` become `EveChannelConfig` and `McpChannelConfig`. Each platform has one
  credentials type, `*ChannelCredentials`, which absorbs the `*Credentials` that Discord, Teams,
  Telegram, and Twilio also export. Continuation-token helpers all take one object
  (`slackContinuationToken({ channelId, threadTs })`), and GitHub exports its own. The 13
  `*ResultOrPromise` aliases become `T | Promise<T>`.
- **Prompt text.** Every definition that carries prompt text calls it `content`: skills and
  markdown schedules follow instructions.
- **Abort signals.** What eve hands you calls it `abortSignal`, as `ctx.abortSignal` does, and
  options you pass call it `signal`, as `fetch` does. All eve-owned sandbox operation options
  use `signal`, including run/spawn and file I/O. Eval contexts and memory-backend inputs carry
  `abortSignal`. Linear activity `signal` is protocol data, not cancellation, and keeps its name.
- **Outbound auth.** `basic` from `eve/agents/auth` becomes `httpBasic`, the name of the inbound
  verifier in `eve/channels/auth`.

</details>

<details>
<summary>Types an app writes are importable</summary>

Adding an export after 1.0 isn't a break, so a forgotten type doesn't block 1.0. A type that an
app writes, to annotate a handler, a helper, or a config it builds, should still be importable by
then. About 320 types appear in public signatures without an export today. Most are brands and
helpers that should stay unnamed, but these are ones apps write:

- Each platform's handler context (`SlackChannelContext`, `TeamsChannelContext`, and the rest),
  and `UploadPolicyInput`, which the eve, Slack, Teams, and Telegram configs accept.
- `SessionSchedule` on `ctx.session.schedule`; `JsonObject`, `JsonArray`, and `JsonPrimitive`; and
  `AgentInfoMemoryEntry`, the one `AgentInfo*` type `eve/client` leaves out.
- `defineAgent`'s `build`, `promptCache`, and tool-exposure options, and `auto()`'s config.
- The sandbox providers' create options, and remote self-modification's config, which local
  self-modification already exports.

</details>

## Keeping it this way

The export list is checked in and enforced, but it records names only. Four checks keep the rest
from drifting back:

- **Shapes.** A declaration report for every entry, `eve/workflow-modules`' ambient modules
  included, so a changed signature shows up in review, not just a renamed export.
- **A clean install.** The packed package, installed into a project with only its required peers,
  typechecks every entry with `skipLibCheck: false`. It catches undeclared packages, bundled
  declarations that import missing files, and types that quietly become `any`. Today's portability
  test checks a few entries inside the workspace, where every devDependency resolves.
- **Reachability.** Types that public signatures reach but that aren't exported, and exported types
  nothing reaches, each against an allowlist.
- **Docs imports.** The snippet check already resolves each `eve/*` path a docs snippet imports;
  it also checks that each imported name is in the export list.

## The numbers

The biggest reductions come from the duplicate exports in the client entries (333 names to about
135), the setup wizard (131 to none), platform channel plumbing (559 to about 400), and the named
instrumentation events (100 to about 40). Most other groups shrink by 5 to 20 percent.

At #4954, the implementation's checkpoint, eve exports 1,504 names. This revision takes that to
about 1,415: extension internals, wire framing, orphaned option types, and deprecated aliases
leave, and a few groups grow slightly as types apps write become importable.

<details>
<summary>Exported names by group</summary>

Measured with the TypeScript checker, counting types and values. The #4855 column covers the 84
entry points the checker resolves there; the generated extension entries need a build first, so
it leaves them out. The #4954 column covers all 85 typed entries, extensions included (73 names).
Neither counts `eve/workflow-modules`' ambient declarations. After-counts apply this plan's
decisions and are rounded where a decision was estimated rather than listed.

| Group                          | #4855     | #4954     | After      |
| ------------------------------ | --------- | --------- | ---------- |
| Clients and hooks              | 333       | 134       | ~135       |
| Platform channels (10 entries) | 559       | 432       | ~400       |
| Setup wizard                   | 131       | 0         | 0          |
| Instrumentation                | 100       | 49        | ~40        |
| Agent authoring (27 entries)   | 288       | 290       | ~300       |
| Evals                          | 92        | 83        | ~83        |
| `eve/events`                   | 219       | 201       | ~185       |
| Built-in tools (13 entries)    | 61        | 47        | ~47        |
| Experimental and extensions    | 61        | 111       | ~70        |
| Channel framework              | 139       | 136       | ~135       |
| Framework adapters             | 22        | 21        | ~18        |
| **Total**                      | **2,005** | **1,504** | **~1,415** |

</details>
