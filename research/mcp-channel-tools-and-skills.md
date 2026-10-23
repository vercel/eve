---
issue: https://github.com/vercel/eve/pull/3926
status: draft
last_updated: "2026-10-02"
---

# Tools on `mcpChannel`

## Summary

An agent that routes work to specialist eve agents today can only hand them whole tasks. The
specialist runs its own model loop, and the router's model reads its prose. eve's MCP connections
already send `tools/call` to any MCP server, but an eve agent publishes none of its own tools:
`mcpChannel` offers only the `agent_*` task tools.

A prototype on branch `rui/vmcp` let an orchestrator call three specialists' tools directly instead.
Replaying 24 cases from the specialists' own eval suites twice, it matched remote subagents on pass
rate (94% each), halved median latency (15 s against 28 s), and used about a quarter of the tokens
(25k against 92k). The prototype branch has no checked-in eval harness or run logs, so these
numbers are background, not reproducible from tracked files.

Phase 1 is the smallest change that makes direct tool calls possible:

1. **`describe()`** (#4077): route handlers can list the agent's invocable tools and their JSON
   schemas.
2. **`invokeTool`** (#4080): route handlers can run one of those tools as a caller, outside any
   conversation.
3. **`mcpChannel({ tools: true })`** (#4124): the channel publishes those tools next to `agent_*`.

Tests are in #4139. Once it lands, any MCP client can call an eve agent's tools with a plain
`tools/call`. Existing `mcpChannel` deployments are unaffected; see [Compatibility](#compatibility).

Skills, tool sessions that last across calls, forwarded principals, and approval or sign-in over
MCP follow later, each tracked in its own issue; see [Follow-ups](#follow-ups).

## How `mcpChannel` works today

`mcpChannel` publishes an agent at `/eve/v1/mcp` for MCP clients such as Claude Code. It serves
`tools/call`, but only for four tools of its own:

| Tool                                       | Does                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `agent_start { message }`                  | starts one durable agent task and returns an `invocationId`                                  |
| `agent_get { invocationId }`               | reads its state: `working`, `input_required`, `authorization_required`, or a terminal status |
| `agent_update { invocationId, responses }` | answers the pending questions                                                                |
| `agent_cancel { invocationId }`            | requests cooperative cancellation                                                            |

Every call to one of these runs a whole agent turn: the model loop, its tools, and its sandbox.

## Why core has to change

A tool's `execute` expects a context that only the harness builds today: the caller in
`ctx.session.auth`, a sandbox through `ctx.getSandbox()`, and credentials through `ctx.getToken()`.
Before `execute`, the harness evaluates the tool's approval policy.

A channel route has none of this. `RouteHandlerArgs` offers session handles (`from`,
`attachSession`, `to`), `waitUntil`, and path params. A route cannot list the agent's tools, run
one with its real context, or evaluate its approval policy. So an MCP server for an agent's tools
cannot be written in userland without reimplementing each tool outside eve.

Two alternatives were rejected:

- **Start a session per call** and ask the agent to run the tool. That puts a model call back in
  front of every tool call, which is the cost this work removes.
- **Keep the logic inside the channel**, as the prototype does. That couples one channel to
  context keys, the approval runtime, tool auth, and the sandbox runtime, and no other channel or
  extension could reuse it.

So phase 1 adds two route args, and `mcpChannel` is built on them like any other channel. The
harness loop does not change.

## 1. `describe()`

```ts
interface RouteHandlerArgs {
  describe(): Promise<AgentDescription>;
}

interface AgentDescription {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly AgentToolDescription[];
}

interface AgentToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /** The tool declares an approval policy. */
  readonly approval: boolean;
}
```

`describe()` lists, sorted by name, only the tools a caller can run outside a turn. One rule in
`channel/tool-eligibility.ts` decides that, and `invokeTool` refuses the same tools. It leaves out:

- framework tools, such as `load_skill` and `agent`;
- tools the harness or a provider runs (`workflow-tool`, `provider-tool`, `dispatch`);
- tools without `execute`;
- tools added by dynamic resolvers or subagents.

Unlike `GET /eve/v1/info`, it carries no paths, config, or diagnostics, so a channel can publish it
as is.

## 2. `invokeTool`

```ts
interface RouteHandlerArgs {
  readonly invokeTool: (
    name: string,
    input: unknown,
    options: { readonly auth: SessionAuthContext; readonly signal?: AbortSignal },
  ) => Promise<InvokeToolResult>;
}

type InvokeToolResult =
  | { status: "completed"; output: unknown; modelOutput: ToolModelOutput }
  | { status: "invalid-input"; message: string }
  | { status: "denied"; reason?: string }
  | { status: "approval-required" }
  | { status: "authorization-required"; connections: readonly string[] }
  | { status: "failed"; message: string; errorId?: string };
```

```text
before: route ──▶ createSession ──▶ turn ──▶ model ──▶ tool
after:  route ──▶ invokeTool ──▶ approval policy ──▶ execute ──▶ result
```

Each call runs in its own session, inside the request:

- **Identity.** `ctx.session.auth.current` and `initiator` are `auth`. `ctx.session.turn` is a
  stand-in that names the call.
- **No turn.** No model, instructions, history, or workflow step. Dynamic resolvers do not run.
- **State.** Authored state starts from its initial value, and updates are not kept.
- **Sandbox.** It opens on the tool's first `ctx.getSandbox()` and is deleted when the call ends.
  Tools that never ask for one start nothing.
- **Approval.** The tool's approval policy runs on every call. If it asks a person, the result is
  `approval-required` and the tool does not run. There is no way to answer yet; see #4159.
- **Sign-in.** A tool that needs a connection sign-in stops where it needs it and returns
  `authorization-required` with the connection names.
- **Errors.** Unexpected failures return a generic message and an error id. The real error is
  logged under that id.

## 3. `mcpChannel({ tools: true })`

```ts
export default mcpChannel({
  auth: oidc({ issuer, audiences: [resource] }),
  tools: true, // default false
  agent: true, // default true: keep serving agent_*
});
```

| `mcpChannel({ ... })`                 | `tools/list`                      |
| ------------------------------------- | --------------------------------- |
| `{ auth }`, before and after          | `agent_*`                         |
| `{ auth, tools: true }`               | `agent_*`, then the agent's tools |
| `{ auth, agent: false, tools: true }` | the agent's tools only            |

- **The SDK owns listing and calls.** Each published tool registers through `McpServer.registerTool`
  with `fromJsonSchema`, so schema checks, `outputSchema`, and the `tools/list` shape stay the
  SDK's.
- **Each `tools/call`** runs `invokeTool` as the route-authenticated caller. A completed call
  returns text content, plus `structuredContent` when the output is an object.
- **Errors.** Every other outcome is an `isError` result with `structuredContent.error.code`:
  `invalid_input`, `denied`, `approval_required`, `authorization_required`, or `internal`.
- **Reserved names.** While `agent` is on, an authored tool named like an `agent_*` tool is not
  published, and eve logs a warning. With `agent: false`, the channel sends no `agent_*`
  instructions. Turning off both options throws.

## Compatibility

- **Nothing changes by default.** A bare `mcpChannel({ auth })`, as d0 and leash use, serves
  exactly the `agent_*` tools it served before.
- **Opting in is a trust decision.** With `tools: true`, every caller the channel's `auth` admits
  can call the agent's tools directly, as themselves, outside the agent's model loop and
  instructions. Leave `tools` off for agents whose tools are not safe to call directly.
- **Unchanged:** the route, `auth`, body limits, the streamable-HTTP transport, `eveChannel`,
  and `defineRemoteAgent`.
- **2025-11-25 clients** list and call tools the same way.
- **Extension contract.** The channel contract moves to epoch 46 and keeps 45, since older
  channels never read the new args.

## Security invariants

1. Every request authenticates through the channel's `auth`, and a tool runs as that caller.
2. Upgrading never widens what a channel publishes: tools stay off until the deployment opts in.
3. Only tools that pass the eligibility rule are listed or run. Framework tools never are.
4. Approval policies run on every call. A call whose policy asks a person never runs.
5. Arguments are checked against the tool's input schema before it runs.
6. No call state outlives the request. Each call's sandbox is deleted when it ends, and is
   dropped from shutdown tracking.
7. MCP callers see only `AgentDescription`, never the inspection payload from `info()`.

## Follow-ups

| Follow-up                                                                          | Issue |
| ---------------------------------------------------------------------------------- | ----- |
| Approval and sign-in over MCP, server and client, on the HITL stack (#4051, #4217) | #4159 |
| Skills over `mcpChannel` (SEP-2640)                                                | #4219 |
| Tool sessions and sandboxes that last across calls                                 | #4220 |
| Tools run as a forwarded user (`trustedForwarders`, `forwardPrincipal`)            | #4221 |
| Relaying input across more than one hop                                            | #4146 |
| Agents as MCP tasks, replacing `agent_*` (phase 2)                                 | #4000 |

A full earlier implementation of every row except phase 2 is on `rui/mcp-full-stack`. Each issue
lists the open review findings for its part.

Also out of scope: choosing individual tools to publish beyond the eligibility rule, and how a
calling model discovers remote tools.

## Validation

- **E2E** (`e2e/fixtures/agent-mcp`, every world suite, scripted mock model): the agent calls its
  own published tool through an MCP connection and gets the tool's exact structured output, run as
  the route-authenticated caller. An approval-gated tool comes back as an approval error, asks
  nobody, and never runs.
- **Unit, `mcpChannel`:** listing order, reserved names, and `agent: false`. Each `invokeTool`
  outcome mapped to its MCP result or error code. Arguments checked against the schema before the
  tool runs.
- **Unit, `invokeTool`:** approval policy outcomes, refusals, and one sandbox per call, deleted
  afterwards.
- **Unit, `describe()`:** only invocable tools, sorted, with `approval` set.

## References

- MCP 2026-07-28: [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr).
- [SEP-2640, skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md);
  [SEP-2663, tasks](https://modelcontextprotocol.io/seps/2663-tasks-extension).
- eve: `docs/channels/mcp.mdx`, `docs/channels/custom.mdx`, `docs/connections/mcp.mdx`.
