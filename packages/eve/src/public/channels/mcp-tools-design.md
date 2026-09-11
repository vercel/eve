# MCP channel tool composition

Status: draft for discussion

## Summary

`mcpChannel()` currently publishes one fixed MCP surface: four tools that start,
inspect, update, and cancel a durable invocation of the agent that owns the
channel. This is a strong default for publishing an agent, but it does not let
an application add a stable operation beside that invocation surface or reuse
an authored eve tool as an MCP server tool.

This proposal evaluates three related capabilities:

1. publishing selected authored eve tools directly as MCP tools;
2. defining MCP-specific tools that are not part of the agent's model-visible
   tool set; and
3. publishing another local or remote eve agent as a named, durable MCP
   capability.

The recommended direction is a composable MCP tool-source model. The existing
durable agent tools remain the default source. Explicit custom MCP tools form
the lowest-level public extension point. Selected authored tools and agent
exports are adapters built on the same internal contract.

Nothing should automatically publish every tool available to an agent.

## Motivation

There are two different meanings of "publish this agent over MCP":

- **Agent invocation:** give the MCP client one durable delegation interface;
  the agent chooses its tools, skills, connections, and subagents internally.
- **Capability publication:** give the MCP client named operations it can call
  deterministically without an extra model-routing step.

The current channel implements the first meaning with `agent_start`,
`agent_get`, `agent_update`, and `agent_cancel`. Applications that need the
second meaning must currently implement another MCP transport or replace the
native channel.

A representative application may want all of these on one authenticated MCP
resource:

- the generic durable invocation tools for the full root agent;
- a direct durable shortcut to a specialist agent;
- one stable read-only authored tool; and
- an application-specific compatibility tool whose contract does not belong in
  the agent's model-visible tool set.

Keeping those capabilities on one server avoids duplicating transport
negotiation, HTTP security, authentication, OAuth protected-resource metadata,
tool-list handling, and protocol compatibility.

## Goals

- Preserve the current invocation-only surface as the safe default.
- Let applications explicitly compose additional MCP tools into the same
  server.
- Reuse eve schemas, authentication, approvals, observability, and durable
  execution where their semantics apply.
- Keep public MCP contracts separate from an agent's private implementation
  details.
- Make least-privilege authorization possible per exported capability.
- Detect duplicate names and unsupported definitions at build time when
  possible.
- Keep the MCP transport implementation owned by eve.

## Non-goals

- Automatically expose every authored, framework, dynamic, connection, or
  subagent tool.
- Treat skills as callable tools. Skills remain instructions loaded by an
  agent.
- Turn every connection-provided operation into an MCP server tool.
- Make an arbitrary authored tool a stable public API without an explicit
  author decision.
- Require eve to operate an OAuth authorization server. The channel remains an
  OAuth protected resource and verifies tokens issued elsewhere.

## Existing behavior

The current `mcpChannel()` always creates the same four tools:

| Tool           | Purpose                                      |
| -------------- | -------------------------------------------- |
| `agent_start`  | Start a durable task-mode agent invocation.  |
| `agent_get`    | Read the invocation's projected state.       |
| `agent_update` | Answer the complete pending input batch.     |
| `agent_cancel` | Request cooperative invocation cancellation. |

This surface has useful properties that every composition option should retain:

- authentication runs for every MCP request;
- invocation ownership is bound to the authenticated principal;
- work is accepted durably before `agent_start` returns;
- human input and connection authorization are projected into explicit states;
- output schemas, cancellation, retention, and terminal errors have one
  protocol-independent representation; and
- modern and legacy Streamable HTTP clients share the same implementation.

## Option A: expose selected authored eve tools

The channel accepts an allowlist of tools already authored under
`agent/tools/`:

```ts
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth,
  tools: {
    include: ["search_docs", "read_status"],
  },
});
```

Names continue to derive from file paths. The channel resolves the named tool
definitions during application assembly rather than requiring authors to
import tool files into the channel.

### Advantages

- No duplicated input schema, output schema, description, or implementation.
- Existing tool execution can retain validation and observability.
- A small allowlist is easy to audit.
- The authored tool remains usable by the agent and directly by an MCP client.

### Risks and unresolved semantics

An authored tool normally runs inside a model turn with `ToolContext`. A direct
MCP call has no pre-existing agent session, turn, messages, sandbox, or channel
metadata. Some tools use all of those. Dynamic tools may not even exist until a
session or turn event resolves them.

Approval is also not a synchronous function-call concern. A tool requiring
human approval must park durable work and expose a continuation; it cannot hold
an arbitrary MCP request open while waiting. Connection authorization has the
same issue.

Possible boundaries for a first version are:

- only static authored tools;
- no tools that depend on channel metadata;
- no dynamic tools or connection-provided tools;
- reject tools with interactive approval unless calls use a durable tool
  invocation adapter; and
- execute with a documented synthetic context containing the authenticated
  principal and no conversation history.

This option is convenient, but it risks making a runtime-private tool contract
public accidentally. The allowlist must therefore be explicit and should
support a separate public description and scope without mutating the underlying
tool definition.

## Option B: define MCP-specific tools

The channel accepts definitions whose only purpose is the MCP server contract:

```ts
import { defineMcpTool, mcpChannel } from "eve/channels/mcp";
import { z } from "zod";

const contentStatus = defineMcpTool({
  description: "Read the current state of a content run.",
  inputSchema: z.object({ runId: z.string() }),
  outputSchema: contentStatusSchema,
  annotations: { readOnlyHint: true },
  async execute({ runId }, context) {
    return await readContentStatus(runId, context.auth);
  },
});

export default mcpChannel({
  auth,
  tools: [contentStatus],
});
```

The example is illustrative. A final API should follow eve's path-derived name
convention, likely by discovering MCP-specific definitions from a dedicated
directory or attaching the discovered file name during compilation.

### Advantages

- The external contract is intentionally authored and can remain stable while
  internal agent tools change.
- MCP annotations, schemas, errors, and descriptions are first-class.
- A tool may aggregate several internal operations.
- Compatibility tools can coexist with the native invocation surface.
- The definition does not enter the model's ordinary tool list unless separately
  authored there.

### Risks and unresolved semantics

- Authors may duplicate logic that already exists in an eve tool.
- A low-level callback can accidentally reimplement durability, ownership, or
  authorization incorrectly.
- Returning raw MCP protocol envelopes would leak the underlying SDK and couple
  eve's public API to it.
- Long-running and interactive operations still need a framework-owned durable
  adapter rather than an application-defined polling protocol.

The callback should receive an eve-owned context and return eve-owned values.
eve should translate those into MCP SDK or wire representations internally.

## Option C: publish another eve agent as a named capability

Many apparent "custom tools" are really agent invocations. A root agent may want
to publish a specialist directly while retaining the root invocation surface:

```ts
export default mcpChannel({
  auth,
  agents: {
    content: {
      description: "Draft and review product content.",
      target: contentAgent,
    },
  },
});
```

This should reuse the native invocation lifecycle rather than asking the
application to implement session creation, polling, input projection,
authorization projection, cancellation, or ownership.

Several protocol shapes are possible:

### C1: one generic invocation family with a target

```text
agent_start({ target: "content", message: "..." })
agent_get({ invocationId: "..." })
```

This keeps the tool list small and the lifecycle uniform, but target discovery
inside a single input enum is less visible to MCP tool selection.

### C2: a start tool per exported agent

```text
agent_start
content_start
agent_get
agent_update
agent_cancel
```

This improves tool selection and permits a specialist-specific description or
input schema while sharing generic lifecycle operations.

### C3: a complete tool family per exported agent

```text
content_start
content_get
content_update
content_cancel
```

This is the most explicit and supports isolated contracts, but it grows the
tool list by four for every export and introduces redundant lifecycle schemas.

C2 is the most promising default. Invocation IDs can identify their target, so
generic read, update, and cancel operations remain unambiguous.

## Option D: replace the built-in surface with arbitrary tools

The simplest configuration shape is a mode switch:

```ts
mcpChannel({ auth, invocation: false, tools: [...] });
```

This is useful for applications that want a conventional MCP server rather
than an agent invocation service. It should be supported if custom tools are
supported, but it should not be the migration path for applications that want
both behaviors. Replacing the fixed surface recreates today's either/or choice.

## Option E: expose a low-level MCP server or request handler

eve could accept an MCP SDK server, a request handler, or raw tool results.

This is not recommended as the primary API:

- it exposes third-party types as eve public API;
- applications can bypass eve HTTP security and auth composition;
- protocol-version compatibility becomes application-owned;
- lifecycle and error behavior diverge across channels; and
- it makes future SDK replacement harder.

An advanced escape hatch may eventually be useful, but the common composition
model should remain eve-owned.

## Recommended model

Internally, build the server from multiple explicit tool sources:

```text
MCP transport
  ├─ native root-agent invocation source
  ├─ custom MCP tool source
  ├─ selected authored-tool adapter
  └─ exported-agent invocation adapter
```

The public API can evolve in stages.

### Stage 1: custom tools plus native invocation

Add an eve-owned `defineMcpTool()` contract and let `mcpChannel()` merge those
tools with the existing invocation tools. This is the foundational composition
primitive and unblocks compatibility surfaces without pretending arbitrary
authored tools already have well-defined direct-call semantics.

### Stage 2: durable agent exports

Add an adapter for local and remote eve agents. Prefer one start tool per export
plus the shared get/update/cancel lifecycle.

### Stage 3: selected authored tools

Add explicit authored-tool exposure after defining synthetic context, approval,
authorization, sandbox, timeout, and durability behavior. Start with static,
non-interactive tools and widen only when semantics are clear.

## Candidate configuration shapes

The exact syntax remains open. These shapes illustrate different tradeoffs.

### Single `tools` list with adapters

```ts
mcpChannel({
  auth,
  invocation: true,
  tools: [exposeTool("search_docs"), exposeAgent("content"), defineMcpTool({/* ... */})],
});
```

This is composable and ordered, but string-based authored-tool lookup and
path-derived custom-tool names need compiler support.

### Separate capability fields

```ts
mcpChannel({
  auth,
  invocation: true,
  authoredTools: ["search_docs"],
  agents: ["content"],
  tools: [customStatus],
});
```

This is easy to understand and validate, but adds configuration surface as new
source kinds appear.

### Filesystem-first exports

```text
agent/
  channels/
    mcp.ts
    mcp/
      content.ts
      status.ts
```

Each sidecar file exports an eve tool adapter, agent adapter, or MCP-specific
definition. Names derive from file paths, and `mcp.ts` controls auth and whether
the root invocation surface is enabled. This fits eve's authoring model but
requires new discovery and build rules.

### Mark exports at the tool definition

```ts
defineTool({
  expose: { mcp: true },
  // ...
});
```

This is concise, but couples a reusable internal tool to one channel and makes
the externally exposed surface harder to audit from `channels/mcp.ts`. It is not
recommended.

## Authorization

Authentication decides who the caller is. Tool export also needs authorization
to decide what that principal may call.

The channel should support explicit required scopes or an authorization policy
per exported capability:

```ts
exposeTool("search_docs", { scopes: ["docs:read"] });
exposeAgent("content", { scopes: ["content:invoke"] });
```

OAuth protected-resource metadata only advertises scopes. It does not enforce
them. The channel or wrapped verifier must reject an authenticated principal
that lacks a required scope with an `insufficient_scope` challenge.

Open questions:

- Should scope enforcement be part of `oauthResource()`, `mcpChannel()`, or the
  application's verifier?
- How are non-OAuth principals authorized against a scope declaration?
- Is a policy callback more general and less misleading than a scope-only API?
- Should `tools/list` hide unauthorized tools or list them and reject calls?

Hiding tools reduces accidental disclosure and client context size, but makes
the tool list principal-dependent. Rejecting calls produces a more stable
server schema. Both behaviors need explicit semantics and tests.

## Execution and durability

Not every direct tool call needs a durable invocation. Three execution classes
are possible:

1. **Request-bound:** execute and return within the MCP request.
2. **Durable operation:** start work and return an invocation ID immediately.
3. **Agent invocation:** use the existing task-mode lifecycle.

Custom MCP definitions should declare their class rather than infer it from
runtime behavior. Request-bound tools should have a bounded timeout and must not
request human input. Durable tools should reuse the invocation projection and
ownership machinery instead of inventing another run-handle format.

An authored-tool adapter must specify which class it uses. Executing every
authored tool synchronously would fail for approvals and long-running work;
executing every tool as a new agent invocation would add unnecessary overhead
and produce surprising semantics.

## Tool naming and conflicts

- Framework invocation names remain reserved by default.
- Export names derive from source paths wherever possible.
- Duplicate names fail application assembly; last-write-wins is unsafe.
- An alias, if supported, is an explicit public compatibility contract.
- Renaming an authored tool does not silently preserve an old MCP alias.
- The server should impose a configurable or documented tool-count limit.

Namespacing every source (`agent_*`, `tool_*`, `connection_*`) is predictable
but noisy. Flat names are friendlier to clients but need strict collision
detection. The existing `agent_*` reservation plus explicit export names is a
reasonable starting point.

## Schema and result behavior

- MCP-facing schemas must be JSON Schema compatible after conversion.
- Unsupported schemas fail at build time where possible.
- Custom definitions return structured eve-owned values, not raw MCP SDK
  envelopes.
- The channel generates both `structuredContent` and a text fallback.
- MCP annotations are explicit and default conservatively.
- Thrown application errors become MCP tool errors without leaking stacks or
  secrets.
- Output size and schema complexity limits should match native invocation
  limits or document why they differ.

## Dynamic capabilities

Dynamic agent tools depend on session state, current messages, auth attributes,
or channel metadata. MCP `tools/list` happens outside an agent turn and may be
cached by clients. Exposing dynamic tools directly therefore has ambiguous
discovery and lifetime semantics.

The first version should reject dynamic authored tools. A future design could
resolve a principal-specific tool list from request auth, but it still lacks a
conversation context and would make schemas change between requests. That
should be a separate proposal.

## Compatibility and migration

Adding tools is protocol-compatible but can affect client model behavior and
context size. Removing or renaming tools is breaking for callers that selected
them explicitly.

Applications replacing a custom MCP server should be able to:

1. keep compatibility tools on the existing route;
2. add the native root-agent invocation tools beside them;
3. migrate clients to the native durable lifecycle;
4. deprecate redundant custom tools; and
5. retain application-owned OAuth authorization-server routes throughout.

Changing an endpoint from specialist-specific tools to only the four generic
agent tools should not be described as a transparent migration.

## Observability

Every exported operation should record:

- MCP server and tool name;
- authenticated principal and authorization decision;
- source kind: native invocation, authored tool, custom tool, or agent export;
- durable invocation ID when applicable;
- approval and authorization waits;
- terminal status, latency, and usage; and
- the same input/output redaction boundaries as ordinary eve tool execution.

Direct authored-tool calls should not masquerade as model-selected tool calls.
They need a distinct span or event classification so operators can distinguish
external API usage from agent behavior.

## Open questions

1. Is custom MCP tool composition sufficient for the first release, or must
   authored-tool reuse ship with it?
2. Should custom definitions be inline, imported, or filesystem-discovered?
3. Should the root invocation surface be configurable, or always present?
4. Is one shared invocation lifecycle enough for exported agents and durable
   tools?
5. What synthetic context is available to a directly invoked authored tool?
6. Which approval modes are legal for request-bound tools?
7. How should connection authorization resume a direct tool invocation?
8. Should tool authorization be scope-based, policy-based, or both?
9. Are unauthorized tools hidden from `tools/list`?
10. Do direct tool calls get a sandbox, and who owns its lifecycle?
11. How are remote-agent descriptions and output schemas projected?
12. Is arbitrary post-completion agent continuation in scope, or does each
    `agent_start` remain a separate task?
13. Should progress events be exposed in addition to the current invocation
    snapshot?
14. What limits apply to tool count, schema size, result size, and request
    duration?

## Proposed decision

Proceed with the composable tool-source architecture, beginning with custom MCP
tools beside the existing invocation surface. Design the internal contract so
authored-tool and agent-export adapters can use it without exposing third-party
MCP SDK types.

Do not automatically export an agent's complete tool graph. Add authored-tool
reuse only after direct execution context and interactive lifecycle semantics
are specified. Add a first-class durable agent export before applications build
more specialist-specific polling protocols themselves.
