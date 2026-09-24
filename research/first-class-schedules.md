---
issue: "None (maintainer-requested prototype; no tracking issue)"
status: proposed
last_updated: "2026-09-20"
---

# First-class schedules

## Decision

Add a **dynamic schedule collection** as a second definition under the existing
path-authored `agent/schedules/` primitive. A collection is an authored
execution template whose schedule instances are created and managed at runtime
through a provider:

```ts title="agent/schedules/queries.ts"
import { byPrincipal, defineScheduleCollection } from "eve/schedules";
import { vercelScheduleProvider } from "eve/schedules/vercel";

export default defineScheduleCollection({
  provider: vercelScheduleProvider(),
  scope: byPrincipal,
  // inputSchema, tools, and run omitted
});
```

The collection and provider are separate contracts with one author-facing
definition helper:

- `defineScheduleCollection(...)` binds path-derived identity, scope, typed
  input, generated tools, and occurrence execution.
- `vercelScheduleProvider()` implements schedule persistence and delivery with
  Vercel Schedules and Vercel Queues.
- `inMemoryScheduleProvider()` implements the same lifecycle for deterministic
  tests and local development.

The prototype does not add a public `defineScheduleProvider(...)` helper.
Built-in factories return the public `ScheduleProvider` interface directly. A
typed helper for custom provider authors can be added later without changing
collection authoring.

Keep the existing `defineSchedule({ cron, markdown | run })` interface and its
Vercel Cron implementation unchanged in the first prototype. A future change
may lower static schedules to Vercel Schedules after the dynamic path is
validated.

A Vercel-backed collection causes eve to emit a private Vercel Queues consumer
at build time. Runtime-created instances target that consumer's agent-scoped
topic. When an occurrence arrives, eve validates it and enters the existing
`ScheduleDispatcher`. This provides first-class dynamic scheduling without
exposing the Vercel SDK as an eve API or moving recurrence, polling, and leasing
into eve. It also offers a migration path for applications that currently
manage scheduled tasks with a database-backed minute poller.

### Public API at a glance

| Import path             | Prototype surface                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve/schedules`         | Existing `defineSchedule`; new `defineScheduleCollection`, `ScheduleProvider`, collection, expression, record, occurrence, and scope types; `byPrincipal` |
| `eve/schedules/vercel`  | `vercelScheduleProvider`                                                                                                                                  |
| `eve/schedules/testing` | `inMemoryScheduleProvider` for explicit tests; `eve dev` installs the same in-memory behavior automatically                                               |

The shape deliberately follows memory:

```ts
// Memory slot: authored policy plus a provider implementation.
defineMemory({
  provider: fileMemory(),
  scope: byPrincipal,
});

// Schedule collection: authored policy plus a provider implementation.
defineScheduleCollection({
  provider: vercelScheduleProvider(),
  scope: byPrincipal,
  inputSchema,
  tools: true,
  run,
});
```

Memory calls the authored unit a slot; schedules call it a collection because
one definition owns many independently managed schedule instances. The provider
property establishes the role, but the explicit factory names remain useful
while the prototype has more than one implementation.

## Product findings

Vercel Schedules adds runtime-created schedules alongside Vercel Cron Jobs.
The product details here reflect the Schedules SDK and product behavior
reviewed for this prototype; availability and limits may change before general
release.

### Static and dynamic schedules

Vercel supports two schedule forms:

| Capability                   | Static                            | Dynamic                          |
| ---------------------------- | --------------------------------- | -------------------------------- |
| Defined through              | `vercel.json` or Build Output API | `@vercel/schedules`, CLI, or API |
| Cron expression              | Yes                               | Yes                              |
| One-time `single` expression | No                                | Yes                              |
| Private function target      | Yes                               | No                               |
| Queue topic target           | Yes                               | Yes                              |
| Change without deploying     | No                                | Yes                              |
| Custom namespace             | No; uses `default`                | Yes                              |

Static schedules are synced on production deployment. Dynamic changes take
effect immediately. Only the production environment is currently supported;
Preview and custom-environment schedules are not yet supported. Queue delivery
selects the production deployment, so eve must not imply Preview isolation.

A schedule has:

- a `name`, unique within `(project, namespace)`;
- a namespace, defaulting to `default`;
- a five-field cron expression or, for dynamic schedules, a one-time local
  datetime in `YYYY-MM-DDTHH:mm:ss` form;
- an IANA timezone, defaulting to UTC;
- a jitter window;
- a function path or queue topic target;
- an optional JSON payload;
- `active` or `inactive` state.

Names and namespaces are 1–256 characters, must start with an ASCII letter or
digit, and may otherwise contain ASCII letters, digits, `.`, `_`, and `-`.
One-time values do not include `Z`, a numeric offset, or fractional seconds;
the timezone is a separate field. Named timezones follow daylight-saving time
changes.

Cron limitations match Vercel Cron Jobs: no named months or weekdays, and both
day-of-month and day-of-week cannot be set. One schedule has at most
minute-level resolution.

Jitter is not optional operationally. Pro and Enterprise accept 1–15 minutes
and default to 1. Hobby always uses 15 minutes, and therefore cannot run a cron
schedule more often than every 15 minutes. The shortest cron interval must be
at least the jitter window. Replacing Vercel Cron with Schedules consequently
changes timing semantics: an authored eve schedule no longer promises execution
at an exact minute, and some frequent schedules become plan-dependent.

Projects may define up to 100 static schedules. The service implementation caps
JSON payloads at 256 KiB, although this limit is not yet stated in the reviewed
product docs.

### Runtime API and CLI

The JavaScript SDK exposes `Schedules` and `SchedulesClient`. It authenticates
with ambient Vercel OIDC in production. `eve dev` uses the in-memory provider
and does not mutate production schedules. Dynamic schedules target queue topics only.

The supported lifecycle is:

```ts
await Schedules.create({ name, namespace, expression, timezone, jitter, target, payload });
await Schedules.list({ namespace, limit, cursor });
await Schedules.get({ name, namespace });
await Schedules.update({ name, namespace, expression, timezone, jitter, target, payload });
await Schedules.enable({ name, namespace });
await Schedules.disable({ name, namespace });
await Schedules.invoke({ name, namespace });
await Schedules.delete({ name, namespace });
```

`update` preserves omitted properties. `jitter: null` removes a custom jitter
and restores the plan default; `payload: null` removes the payload. `invoke`
queues an immediate asynchronous occurrence without changing cadence or state,
and it also works for an inactive schedule.

The beta `vercel schedules` command exposes the same lifecycle through
`create`, `list`, `get`, `update`, `enable`, `disable`, `invoke`, and `delete`.
Lists default to 20 entries and cap at 100. Resources are addressed by name and
optional namespace, not by requiring a schedule ID from the model.

The returned SDK resource describes expression, target, state, timestamps, and
schedule identity, but does not include the configured payload. That omission
matters for eve: a generated `list_schedules` tool can show cadence and state,
but cannot show or edit a previously stored agent prompt or typed input without
replacing it from information supplied by the caller. Applications that need
to display or edit existing prompts cannot replace their own schedule store
until Vercel provides authorized payload readback or equivalent metadata.

### Dispatch and observability

A queue-target occurrence publishes this body:

```ts
interface VercelScheduleMessage<T> {
  scheduleId: string;
  name: string;
  namespace: string;
  firedAt: string;
  source: "static" | "dynamic";
  payload?: T;
}
```

The payload is nested under `payload`; schedule metadata remains at the top
level. Consumers use `handleCallback` from `@vercel/queue` and are private
`queue/v2beta` functions. Delivery inherits Vercel Queues' at-least-once
semantics, retries, deployment partitioning, and lack of strict ordering.

The Vercel dashboard already builds a project schedule inventory across
namespaces from `schedules_v1` and 90 days of dispatch operations. It shows
current configuration, latest retained dispatch, and an estimated next run.
The estimate accounts for timezone and DST but may precede actual delivery by
the jitter window. The inventory intentionally has no target error rate because
successful dispatch does not establish successful function or agent execution.

A future observability integration should link
an Agent Run that created or changed a dynamic schedule to that schedule, and
link each schedule occurrence to the Agent Run it triggered. These links must
use safe identifiers and existing run access controls; prompts, payloads, raw
namespaces, and principal attributes must not become indexed attributes.

## Authoring model

Static definitions and dynamic collections coexist under `agent/schedules/`:

```text
agent/schedules/
  daily-report.ts   # defineSchedule({ cron, ... })
  queries.ts        # defineScheduleCollection({ provider, ... })
```

The compiler distinguishes the branded definitions. Their identities continue
to come from their paths; neither form adds a redundant `name` field.

### Dynamic schedule collections

A collection describes a family of runtime-created schedule instances that
share one provider, scope policy, input schema, execution handler, and set of
management tools:

```ts title="agent/schedules/queries.ts"
import { byPrincipal, defineScheduleCollection } from "eve/schedules";
import { vercelScheduleProvider } from "eve/schedules/vercel";
import { z } from "zod";
import slack from "../channels/slack";

export default defineScheduleCollection({
  description: "Run saved queries on a user-defined schedule.",
  provider: vercelScheduleProvider(),
  scope: byPrincipal,
  inputSchema: z.object({
    query: z.string().min(1).max(20_000),
  }),
  tools: true,
  async run({ appAuth, input, to }) {
    // Application policy, not model-supplied schedule input, selects the destination.
    const channelId = await resolveAuthorizedDestination();
    await to(slack, { channelId }).send(
      `Run this saved query and report the result:\n\n${input.query}`,
      { auth: appAuth },
    );
  },
});
```

The `queries` collection may own Alice's weekly incident query, Bob's weekday
deployment query, and a shared channel's monthly report as separate provider
instances. The definition itself has no cadence.

The provider is explicit. `vercelScheduleProvider()` uses Vercel Schedules in a
Vercel production deployment and declares the build-time queue capability the
collection needs. The provider factory also supplies its in-memory development
adapter when eve identifies `eve dev`; authors do not write a `NODE_ENV`
conditional or substitute a provider manually. `inMemoryScheduleProvider()` is
available for deterministic tests and applications that explicitly want
process-local behavior. Development never mutates production schedules and does
not run a background clock. Other unsupported environments fail with setup
guidance rather than silently selecting process-local storage.

The portable expression mirrors the product rather than introducing an
eve-specific recurrence language:

```ts
type ScheduleExpression =
  | { type: "cron"; cron: string; timezone?: string; jitter?: number }
  | { type: "single"; at: string; timezone?: string };
```

The dynamic handler receives validated `input` and occurrence metadata in
addition to today's `to`, `waitUntil`, and `appAuth`. The collection author
defines the payload schema, including any task, destination, and execution
identity choice. When generated management tools need trusted creation context,
an optional `resolveInput(input, context)` hook resolves validated proposed
input using trusted creation context before storing it. It can resolve relative
destinations and derive an owner reference from the authenticated caller. It is not a framework-defined
destination or delegation policy.

The collection decides which identity to use when handing off work: pass
`appAuth` for app-owned tasks, or call an application-owned resolver for an
explicit `runAs: "author"` request and pass its freshly resolved user auth.
`runAs` is an example of an author-defined payload field, not an eve option.
Keep resolution and platform-specific authorization checks in application
helpers so `run` only selects an identity and dispatches the task. eve does not
implicitly persist the creator's full `SessionAuthContext` or reconstruct a
user from a thread, namespace, or model-supplied ID; those values do not prove
current authority. Store only a bounded author reference, establish its
binding to the schedule at creation, and recheck current identity and grants
at delivery. If those checks cannot be made, fail closed rather than falling
back to app auth. Do not treat `byPrincipal` management scope as delegation.

Documentation should show both modes and state their consequences: app auth
cannot access the creator's principal-scoped memory or personal connections;
on-behalf-of execution can, subject to current grants and the application's
scheduled-run restrictions. Neither mode should gain schedule-management
rights solely from replying in an existing conversation. The framework must
also recover a previous turn's durable tool callbacks independently of the
next turn's caller; choosing author auth does not replace that recovery fix.

### Scope and namespace

A collection requires a trusted scope definition. `byPrincipal` derives scope
from the authenticated caller and returns `null` for anonymous and runtime
principals. Shared channel schedules use an authored resolver over trusted
channel metadata.

Scope controls management authorization. The model never supplies a namespace,
project ID, queue topic, or owner ID. eve derives a Vercel-compatible opaque
namespace from application identity, graph node, collection path, and the
canonical scope. The encoding must:

- satisfy Vercel's identifier grammar and 256-character limit;
- distinguish scalar and tuple scopes without delimiter collisions;
- separate projects, agents, collections, and tenants;
- avoid putting raw user, tenant, channel, filesystem, or Preview deployment
  values into the platform namespace.

Vercel's project boundary is necessary but not sufficient for tenant
authorization. Every fetched record and dispatch payload also carries a
versioned eve envelope that binds it to the expected application, collection,
and opaque scope key. Cross-scope reads and mutations return not found.

### Generated management tools

`tools: true` derives ordinary dynamic tools from the collection:

- `<collection>__create_schedule`
- `<collection>__list_schedules`
- `<collection>__read_schedule`
- `<collection>__update_schedule`
- `<collection>__enable_schedule`
- `<collection>__disable_schedule`
- `<collection>__delete_schedule`
- `<collection>__invoke_schedule`

`invoke` runs a schedule immediately without changing its timing or state. Like
create, update, enable, disable, and delete, it is model-facing by default and
uses `always()` approval.

The implementation uses the same programmatic source-template and
`defineDynamic` tool machinery proposed for first-class memory. Schedule tools
therefore use existing source selection, qualification, approval,
authorization, callback rebinding, and replay behavior instead of adding a
schedule-specific tool registry.

Tools use the path-derived collection and locked scope. Create accepts a
user-facing name, expression, and typed input. Later operations use the name
returned by create/list. Delete defaults to `always()` approval. Definitions
may override descriptions and approval policies. The expanded form makes the
invoke boundary explicit:

```ts
 tools: {
   create: true,
   read: true,
   update: true,
   delete: true,
   invoke: true,
 },
```

`tools: true` means the same defaults. Omitted object properties also default
to `true`, so an application that does not want immediate execution can use
`tools: { invoke: false }`. Enable and disable belong to update management and
remain available. The provider-level `invoke` operation also supports
application code, smoke tests, and local manual dispatch.

Generated read/list results expose only what the provider can read. For the
initial Vercel provider, this means name, expression, timezone, jitter, target
state, source, and timestamps—not the stored input. Until payload readback
exists, update requires a complete replacement `input` whenever it changes;
eve must not claim it can display or patch an unseen prior prompt.

## Provider contract

A provider owns schedule persistence and lifecycle. eve owns scope locking,
portable validation, target selection, dispatch envelopes, generated tools,
and execution.

```ts
interface ScheduleProviderContext {
  readonly abortSignal: AbortSignal;
  readonly collection: string;
  readonly namespace: string;
  readonly operationId: string;
  readonly target: ScheduleDeliveryTarget;
}

interface ScheduleProvider {
  create<T>(ctx: ScheduleProviderContext, input: ScheduleCreate<T>): Promise<ScheduleRecord>;
  list(ctx: ScheduleProviderContext, input: ScheduleList): Promise<SchedulePage>;
  get(ctx: ScheduleProviderContext, name: string): Promise<ScheduleRecord | null>;
  update<T>(
    ctx: ScheduleProviderContext,
    name: string,
    patch: SchedulePatch<T>,
  ): Promise<ScheduleRecord>;
  enable(ctx: ScheduleProviderContext, name: string): Promise<ScheduleRecord>;
  disable(ctx: ScheduleProviderContext, name: string): Promise<ScheduleRecord>;
  invoke(ctx: ScheduleProviderContext, name: string): Promise<void>;
  delete(ctx: ScheduleProviderContext, name: string): Promise<boolean>;
}
```

`ScheduleRecord` is an eve-owned projection; it does not expose a Vercel SDK
type, project ID, queue topic, deployment ID, OIDC token, or raw namespace.
The prototype publicly exports the `ScheduleProvider` contract and the
`vercelScheduleProvider()` and `inMemoryScheduleProvider()` implementations. It
does not export `defineScheduleProvider(...)`; that helper is unnecessary until
applications need to author custom providers.

Durable tool replay requires mutation idempotency. The Vercel provider should
forward an idempotency key when the product supports one. If create cannot be
made idempotent atomically, its deterministic `(namespace, name)` identity may
recover a prior successful create only after verifying that the existing
envelope matches the same collection and operation. A same-name conflict with
different content remains an error. Delete, enable, disable, and invoke need
explicit replay tests; an uncommitted replay of `invoke` must not produce two
manual occurrences.

## Nitro and Vercel integration

### Conditional queue consumer

The prototype does not change how existing static schedules compile. When the
compiler selects at least one collection backed by
`vercelScheduleProvider()`, the application build emits one dedicated private
schedule consumer function with a `queue/v2beta` trigger for an agent-scoped
topic. A deployment with no such collection emits no schedule consumer.

The existing eve Workflow queue function is a useful Nitro pattern but remains
separate: schedule and Workflow messages have different schemas, retry policy,
duration, and poison-message behavior. Multi-agent Vercel Services require one
collision-free topic and consumer per agent service.

Nitro needs a supported preset contract for this private queue consumer or an
output hook that lets eve add it without reimplementing the Vercel preset.
Runtime collection instances all target the generated topic; the model and
authored code never receive or select it.

After this path is validated, a separate change can replace static Vercel Cron
lowering with Build Output `schedules[]` entries targeting the same consumer.
That migration must account for Vercel Schedules' jitter, plan limits, timezone
semantics, and production-only support, and is outside the prototype.

### Queue consumption and durable handoff

The generated consumer validates and bounds the Vercel envelope and nested eve
payload before loading authored code. It rejects mismatched collection, scope,
application, or schema versions without logging payload content.

Use `(scheduleId, firedAt)` as the occurrence identity. Queue delivery is
at-least-once, so admission must durably return the original dispatch result
when that identity is redelivered. The consumer acknowledges after the
occurrence has been admitted to eve's durable runtime, not after a potentially
long or parked agent session completes.

Dynamic occurrences then call the existing `ScheduleDispatcher` through a
collection-aware dispatch input. Collections can start durable task-mode work
or hand work to channels using the same runtime primitives as existing schedule
handlers. Current schedule provenance and conditional-delivery behavior remain
intact.

Configure a finite queue delivery limit. A malformed, permanently incompatible,
or unauthorized message becomes a content-free diagnostic and is acknowledged
as poison rather than retrying until queue retention expires. Transient
admission failures remain retryable.

## Observability

Extend schedule provenance from one static name to structured internal data:

- authored collection ID;
- Vercel `scheduleId`;
- occurrence ID and `firedAt`;
- source (`static` or `dynamic`);
- creating and last-mutating Workflow run IDs when available.

Preserve the current public `scheduleId` projection during migration. Add only
opaque identifiers to reserved Workflow attributes, for example:

```text
$eve.schedule              reminders
$eve.schedule_id           sch_…
$eve.schedule_occurrence   sch_…:2026-09-20T09:00:00.000Z
$eve.schedule_source       dynamic
$eve.schedule_created_by   wrun_…
```

The project Schedules inventory can then link a schedule to the Agent Run that
created or changed it, while a triggered Agent Run links back to its schedule
and occurrence. Apply the same run masking and access controls noted in the
existing run access controls. Never index the prompt, payload, namespace,
scope, destination, or principal attributes.

Emit metrics for control-plane operations, fire-to-queue latency,
queue-to-admission latency, duplicate admission, schema rejection, poison
acknowledgement, and durable session outcome. Keep target execution failures
separate from platform dispatch status, matching the dashboard's current
observability distinction.

## Migration boundary

Applications with their own schedule store can adopt Vercel-backed cadence
while keeping existing authorization, readable prompts, and destination
policies in their own data model. Removing a poller requires a separate
migration after payload readback, replay safety, and run provenance can preserve
those behaviors. The prototype does not migrate existing applications or
change static schedules.

## Rejected alternatives

- **Keep the database minute poller as eve's default.** It retains polling
  latency, recurrence and DST code, leases, recovery, and a mandatory durable
  store that Vercel Schedules already provides.
- **Expose `@vercel/schedules` directly.** This leaks a third-party API, loses
  provider portability, and gives model-facing code project-level operations
  without eve's scope lock.
- **Use one platform schedule per collection and poll tenant rows.** This merely
  moves the existing dispatcher behind one Vercel tick; tenant instances still
  need independent cadence and state.
- **Send dynamic occurrences to a public HTTP route.** Dynamic Vercel Schedules
  target Queues. The private consumer has the intended authentication,
  deployment routing, and retry behavior.
- **Acknowledge only after the agent finishes.** Long or parked sessions would
  outlive queue leases and cause duplicate execution. Durable admission is the
  handoff boundary.
- **Claim full management without payload readback.** The SDK resource cannot
  currently reconstruct an existing prompt or typed input. eve should expose
  that limitation rather than add a hidden second source of truth.
