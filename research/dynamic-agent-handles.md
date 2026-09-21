---
issue: "untracked"
status: draft
last_updated: "2026-09-21"
---

# Dynamic agent discovery

Generalize the existing agent handles into one session registry of advertised destinations that tools and startup hooks can populate, independently of whether a destination has a running session.

The examples use proposed APIs. Each handle continues one conversation; registration
does not require that conversation to exist yet.

## Example: a new conversation knows about earlier user sessions

A user opens a new chat and says, “Let's change the dates for the Japan trip.”
They planned that trip in another session last week. The current agent should be
able to identify that conversation without asking the user to find and paste its
session ID.

For an authenticated user, the application loads a small set of recent sessions
at `session.started` from its session catalog and registers them. The first model
request might advertise **Japan trip — November** and **Kitchen renovation budget**, each
with a short summary and a handle. This reveals which conversations exist; it does
not load their full histories or send messages to them.

`sessionCatalog` and `toAgentDestination` below are application-owned helpers, not
existing eve APIs. Their [required contract](#application-session-catalog) is part
of the example. In particular, catalog queries must scope results to the verified
caller and exclude the current session.

```ts
// agent/hooks/past-sessions.ts
import { defineHook } from "eve/hooks";
import { sessionCatalog, toAgentDestination } from "../../lib/session-catalog";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      const sessions = await sessionCatalog.recent({
        principal: ctx.session.auth.current,
        excludeSessionId: ctx.session.id,
        limit: 5,
      });
      for (const session of sessions) {
        ctx.registerAgent(toAgentDestination(session));
      }
    },
  },
});
```

**Why dynamic registration:** the destinations are this user's actual conversations,
created over time. Static agent declarations cannot enumerate those session IDs.
The limit of five is this application's context budget, not a framework rule.

## Example: find an older conversation when the user refers to it

The user says, “Pick up the kitchen renovation budget from February.” It is no
longer among the recent sessions loaded at startup. A tool queries the same catalog
on demand and registers the matching sessions. Search implementation and ranking
remain application concerns.

```ts
// agent/tools/find-past-session.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { sessionCatalog, toAgentDestination } from "../../lib/session-catalog";

export default defineTool({
  description: "Find earlier conversations the current user can access.",
  inputSchema: z.object({ query: z.string().min(1) }),
  async execute({ query }, ctx) {
    const sessions = await sessionCatalog.search({
      principal: ctx.session.auth.current,
      excludeSessionId: ctx.session.id,
      query,
      limit: 5,
    });
    const matches = sessions.map((session) => {
      const handle = ctx.registerAgent(toAgentDestination(session));
      return { title: session.title, agentId: handle.id };
    });
    return { matches };
  },
});
```

On the next eligible model request, the registry advertises the matches with their
summaries. The tool also returns titles and handles to make its lookup result
explicit; those returned values are not what controls registry publication.

If the user asks to revise the earlier budget, authored tool code can deliver to
the selected handle:

```ts
const budget = { id: selectedAgentId };
await ctx.agent(budget, { message: "Revise the renovation budget to include new windows." });
await ctx.agent(budget, { message: "Correction: use the existing window measurements." });
```

Both deliveries go to the February budget session, with that session's existing
conversation context. They do not create a new budget agent. The caller's current
chat does not automatically acquire that context. A delivery may run the receiving
agent and its tools; it is not a read-only way to inspect history.

**Why a tool:** load additional destinations when they become relevant, rather
than advertise every past conversation at the start of every session.

## Awareness, reading, and continuation are different actions

| User intent                                 | What the application needs                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| “What were we working on?”                  | Advertise authorized session titles and summaries; no prior agent needs to run.                                                         |
| “What budget did we agree on in February?”  | Read authorized history or an artifact. Registration alone does not retrieve either. Asking the earlier agent is a separate invocation. |
| “Continue that budget and add the windows.” | Deliver to the handle bound to the earlier session; further deliveries continue it.                                                     |

Which of these experiences should the first use case cover is still a research
question. Do not treat registering a session as permission to read its transcript,
execute its tools, or cancel work inside it.

A past session may be unavailable or no longer accept deliveries. Discovery must
not imply it can be resumed, and a failed continuation must not silently replace
it with an empty conversation. We still need to decide how read-only archived
sessions fit: as registry destinations with explicit capabilities, or through a
separate history-reading surface.

## Another use case: join an existing project investigation

A new conversation about checkout latency should be able to find the investigation
session already used by the project team. A project directory can advertise that
session, even though the current agent did not create it and has no parent/child
relationship with it. A follow-up such as “The reproduction now also fails on
mobile” belongs in that existing investigation.

This needs project-scoped discovery and delivery authorization. It does not grant
the discovering agent ownership of the investigator's work. The [external file
adapter](#external-directory-loader) below illustrates one operator-managed source;
the registry mechanism is the same as for user sessions.

## What we have aligned on

- **Discover destinations.** An agent can know about another agent without knowing
  whether it is running, reachable, or currently accepting work.
- **One registry.** Generalize the existing handles collection. `AgentRegistry`
  replaces that abstraction; it does not introduce a second collection. Existing
  static agents participate in the same model.
- **Registration is an authoring operation.** Ordinary tools can register handles
  inside `defineTool.execute`; startup hooks can populate the registry too.
- **Membership means advertisement.** Every registered destination is advertised.
  Search and ranking stay outside this mechanism: a future search tool produces
  registrations like any other tool.
- **Handles are callable.** A tool can pass the returned handle to `ctx.agent()`.
  Registration, advertisement, and calling need explicit boundaries.
- **One handle, one conversation.** Repeated calls continue the same receiving
  session, with the same semantics as successive deliveries to that session.

The starting limitation is that the [existing handles][original-store] primarily
record delegated children and their execution state. Adding discovery should make
how an entry was obtained irrelevant to its later use.

## Terms and proposed API

A **destination** identifies an agent that can be addressed. A **handle** is the
caller's reference to a registered destination. A **registry** is the session's
collection of those entries. An **invocation** is an attempt to send work to a
destination; a **conversation** is the receiving agent session in which work runs.
A handle may be registered before its conversation exists. Its initial delivery
establishes that conversation, or uses the existing session named at registration;
subsequent deliveries through the handle continue the same conversation.

| Proposed operation                 | Purpose                                                                           | Decision still needed                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `registerAgent(destination)`       | Return a handle that code can use immediately and the model can subsequently see. | Identity, duplicate registration, and replacement rules.                  |
| `agent(handle, input)`             | Address the registered destination through the ordinary calling path.             | Return value and authority to deliver or cancel work.                     |
| `updateAgent(handle, description)` | Change what the model is told about a destination.                                | Whether updates may also change routing, and how stale references behave. |
| `unregisterAgent(handle)`          | Remove the destination from subsequent advertisements and handle lookups.         | Treatment of accepted work and later re-registration.                     |

Static declarations supply destinations through the same registry. Their authored
configuration still determines capabilities and credentials. A new registry should
not require a separate calling API just because an entry came from a directory.

## Agreed conversation semantics

A handle is a reference to one conversation, including before that conversation
has been established. Calling it again is another delivery to that session. Whether the receiving session
is idle or working, delivery follows its normal session semantics. The registry
should not introduce a separate busy/claim policy for the same operation.

Registration itself does not start the conversation. If a destination is offline,
the handle remains registered. Once bound, a failed delivery must not silently
start a replacement conversation. A fresh conversation requires an explicit
choice; the authoring operation for that choice remains to be designed.

## When registry changes enter context

The proposed boundary is: code sees a registration immediately; the model sees a
snapshot when its next request is prepared. Persistence and failure behavior need
an explicit rule rather than inheriting whichever callback currently commits state.

Let `R` be the session registry, `h` the returned handle, and `M` the registry
listing included in a particular model request. These are proposal notation, not
new runtime APIs.

| Boundary                        | Registry and model state                                       | Side effect                                                             |
| ------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| External lookup                 | `R` is unchanged.                                              | The tool or hook reads the external source.                             |
| `registerAgent(destination)`    | `R` now contains `h`; an existing `M` is unchanged.            | Validate and record the destination; do not contact it.                 |
| Later code in that callback     | `ctx.agent(h, input)` can resolve `h` from `R`.                | An invocation can contact the destination before another model request. |
| Request after `session.started` | `M` includes registrations made by the startup hook.           | Send the first model request with the listing.                          |
| Request after a discovery tool  | `M` includes the updated registry after required tool results. | Send the next model request with the listing.                           |
| Already-running model request   | Its `M` stays unchanged.                                       | No retroactive context mutation.                                        |
| Session checkpoint and resume   | Restore the committed registry before preparing another `M`.   | Persist accepted changes; rollback rules remain to be decided.          |

The listing needs identity and enough description to choose a destination. Being
listed must not imply that the destination is reachable, idle, or authorized for
this particular request. Routing coordinates and credentials are separate from
what the model needs to see.

## Calling is part of the research

The API needs to distinguish destination knowledge from invocation outcomes:

| Situation                                     | Required distinction                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No conversation exists                        | Registration still succeeds; the initial delivery establishes the conversation for this handle.                                                |
| Destination is offline or rejects the request | The invocation fails; that does not by itself invalidate knowledge of the destination.                                                         |
| Work is already running                       | Deliver to the same session using its normal delivery semantics; do not branch into another conversation or add a handle-specific busy policy. |
| A response is lost after remote acceptance    | The caller cannot infer that work never started. Retry semantics need to account for duplicate delivery.                                       |
| An existing external session is registered    | Addressability does not establish authority to reset the session or cancel another caller's work.                                              |
| An entry is removed or replaced               | Define what stale handles and already-accepted invocations mean independently of advertisement.                                                |

The parent/child ownership discussion belongs here as a design dependency.
A handle identifies what is being addressed; an internal task ID may identify an
invocation. The existence of the current task/claim implementation does not settle
which identifiers authors need or which calls should be accepted.

## What this enables and how to judge it

An application can make a new chat aware of recent user sessions, discover older
conversations on demand, or connect a new agent to an existing project investigation.
These all use the same registration mechanism. Search ranking and source
integrations remain application concerns.

The proposal should be explainable through these observable checks:

- Startup registration appears in the first model request without starting agents.
- A tool registers `h`, uses it in the same execution, and the next model request
  advertises it even if the tool did not return the handle.
- Static and externally discovered destinations use the same lookup and calling
  rules once registered.
- An offline destination remains known after a failed call; the failure reports
  an invocation outcome rather than silently choosing a different conversation.
- Repeated calls through one handle reach the same receiving session, including
  while that session is working. An unavailable bound session is not replaced.
- Removal, failed callbacks, concurrent initial calls, and restart each have a
  specified result that preserves this invariant and the decisions above.

The [experimental registry][registry], [context tests][context-tests], and
[publication tests][publication-tests] provide implementation evidence to challenge
these rules. Passing them would not by itself establish that the design is right.
The [authoring docs][authoring-docs] should follow the resulting research decisions.

## Decisions to align on

1. **Registration identity and lifetime.** What makes two descriptors refer to the
   same handle and conversation? Are keys aliases or identities? What survives
   removal, replacement, and session resume? How does a caller explicitly request
   a fresh conversation, and what may an update change?
2. **Delivery result and authority.** What does `ctx.agent(h, input)` return, and
   who can deliver, steer, or cancel work in that session? Should ordinary tools
   and workflows expose different completion behavior? Concurrent initial calls
   must preserve one conversation per handle; how is that established durably?
   Distinguish permission to discover metadata, read history, and deliver work.
3. **Commit and publication.** Which callback/checkpoint commits registration?
   What happens if a tool registers and then fails, or invokes before the step is
   persisted? Does an update ever wake an idle agent?

Evaluate these choices against predictable calling behavior, explicit authority,
and the amount of state authors must understand. Exact capacities, transport
adapters, serialized keys, provider classes, and task-claim machinery follow those
decisions; they should not define them.

## Application session catalog

The examples assume the application maintains an index of retained sessions.
They do not assume that eve already provides a per-user session search API.
The index supplies metadata and routing; it does not copy another session's
transcript into the current agent.

An illustrative record is:

```ts
interface CatalogSession {
  key: string; // Stable catalog key, unique across the indexed destinations.
  sessionId: string;
  url: string;
  title: string;
  summary: string;
}

export function toAgentDestination(session: CatalogSession) {
  return {
    key: session.key,
    description: `${session.title}: ${session.summary}`,
    target: { kind: "remote" as const, url: session.url, sessionId: session.sessionId },
  };
}
```

`recent` and `search` query that index using the verified caller supplied by the
hook/tool context. They reject an absent or unauthorized principal, enforce
session-specific access before returning even titles and summaries, exclude the
current session, and bound the result set. A model-supplied query must not supply
or override the user identity. Continuation must independently authorize delivery
to the selected session; an earlier lookup is not a durable access grant.

These are required application behaviors, not claims about the prototype. The
[current auth documentation][session-auth] explicitly leaves session ownership to
the application. The research must account for same-application session addressing
and authenticated delivery; the remote URL shape here is illustrative, not a
requirement to make user sessions publicly callable.

Re-discovering the same catalog record at startup and through a tool also exercises
the open duplicate-registration rule: should it return the existing handle and
conversation? The current branch does so for identical descriptors; the catalog
example gives us a concrete case against which to assess that rule.

## External directory loader

A project-scoped application can also load destinations from an operator-managed
file. This is an alternative to the user-session catalog, not its implementation.
Set `AGENT_DIRECTORY_PATH` to a JSON file outside the agent directory:

```json
[
  {
    "key": "checkout-investigation",
    "description": "Ongoing checkout latency investigation; includes the mobile reproduction.",
    "url": "https://investigator.example.com",
    "sessionId": "checkout-investigation-session"
  }
]
```

`lib/agent-directory.ts` reads and validates the file. The schema is illustrative
application validation, not a proposed framework capacity or transport policy.

```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";

const directory = z.array(
  z.object({
    key: z.string().min(1).max(128),
    description: z.string().min(1).max(2048),
    url: z.string().url(),
    sessionId: z.string().min(1).optional(),
  }),
);

export async function readAgentDirectory() {
  const path = process.env.AGENT_DIRECTORY_PATH;
  if (!path) throw new Error("Set AGENT_DIRECTORY_PATH to the agent directory JSON file.");
  const entries = directory.parse(JSON.parse(await readFile(path, "utf8")));
  return entries.map(({ key, description, url, sessionId }) => ({
    key,
    description,
    target: { kind: "remote" as const, url, sessionId },
  }));
}
```

An optional `sessionId` illustrates a directory advertising an existing
conversation. Omitting it defers conversation creation until the first call.
Both forms continue one conversation on subsequent calls. Knowing a session ID
does not establish permission to call or cancel it.

## Research status

This is the design discussion. The implementation in [draft PR #3567][pr] is an
experiment against the proposal, not the specification. Open decisions remain
open even where the branch already chose a behavior.

[pr]: https://github.com/vercel/eve/pull/3567
[original-store]: https://github.com/vercel/eve/blob/d88aedeef375c654a04da7e81bb06e7098478306/packages/eve/src/subagents/handles/store.ts
[registry]: ../packages/eve/src/subagents/registry/registry.ts
[context-tests]: ../packages/eve/src/context/agent-registry.integration.test.ts
[publication-tests]: ../packages/eve/src/harness/tool-loop.test.ts
[authoring-docs]: ../docs/subagents/index.mdx#register-destinations-at-runtime
[session-auth]: ../docs/guides/auth-and-route-protection.md#what-reaches-ctxsessionauth
