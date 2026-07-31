---
issue: https://github.com/vercel/eve/issues/100
status: proposed
last_updated: "2026-07-28"
---

# ACP adapter requirements

## Purpose

Allow an Agent Client Protocol (ACP) client to launch an authored eve application or bridge to a deployed eve agent:

```sh
eve acp
eve acp https://agent.example.com
```

The adapter translates stable ACP v1 over stdio to eve's public `Client` and `ClientSession` API. Without a URL, it supervises the normal local development server; with a URL, it connects to that deployment's existing eve HTTP API. ACP is an additional client surface rather than a second agent runtime.

The first release is intended for editors, desktop agent hosts, and local protocol harnesses. It is platform-neutral: it must not contain Buzz, Nostr, editor, or provider-specific behavior.

In this document, **must**, **should**, and **may** are normative requirements.

## Outcomes

The first release must let a conforming ACP v1 client:

- initialize and discover the adapter's actual capabilities;
- create multiple independent conversation sessions;
- send text prompts and render streamed messages, reasoning, and tool activity;
- answer tool permissions and supported structured questions;
- cancel active prompts without racing a subsequent prompt;
- close sessions and terminate the owned development process cleanly.

Existing `eve dev`, `eve dev --no-ui`, and TUI behavior must remain unchanged when ACP mode is not selected.

## Non-goals

The first release does not provide:

- a deployed ACP HTTP or WebSocket endpoint;
- ACP v2 support;
- ACP Streamable HTTP or WebSocket transport;
- Buzz, Nostr, or any other platform integration;
- client filesystem or terminal access;
- mounting the client's `cwd` into an eve sandbox;
- client-provided MCP servers or dynamic MCP connection injection;
- ACP session listing, loading, resumption, or durable ACP IDs across adapter restarts;
- model selection or other ACP session configuration;
- compatibility behavior for unsupported input that silently drops or flattens data.

Remote targets and platform channels require separate requirements because their trust, identity, credential, and lifecycle boundaries differ from a local subprocess.

## External contract

### R1: CLI selection

1. `eve acp` must select ACP mode explicitly. Non-TTY detection must not enable it implicitly.
2. `eve acp` without a URL must supervise an isolated loopback local development server. `eve acp <url>` must connect to that URL through eve's public `Client` API without starting a local server.
3. URL targets must accept the same credential-bearing URL and repeatable request-header inputs as `eve dev <url>`. Credentials must use the client's existing redirect policy and never be forwarded to another origin.
4. Local ACP mode must use the same compilation, watch, generation-pinning, and runtime behavior as ordinary `eve dev`.
5. The process exit status must be nonzero for boot, configuration, authentication, or unrecoverable protocol failures.
6. The CLI help must describe ACP as a stdio agent bridge and state that it does not grant access to the client's workspace.

Example client configuration:

```json
{
  "command": "pnpm",
  "args": ["exec", "eve", "acp"]
}
```

### R2: stdio integrity

1. stdin and stdout must be reserved for newline-delimited JSON-RPC messages.
2. Every non-empty stdout line must be one complete valid JSON-RPC message. Protocol messages must never be split across lines.
3. Boot progress, compiler output, rebuild diagnostics, runtime logs, warnings, and uncaught-error detail must go to stderr.
4. Logging during boot failure, rebuild, tool execution, and shutdown must not corrupt stdout.
5. The adapter must apply a finite inbound line-size limit and reject oversized input without unbounded buffering.
6. A malformed JSON-RPC message must receive the appropriate parse or invalid-request error when an ID can be correlated. It must not crash unrelated sessions.
7. Unknown request methods must return JSON-RPC `method not found`; unknown notifications may be ignored as required by JSON-RPC.

### R3: protocol version and capabilities

1. The adapter must implement stable ACP v1 as defined by the pinned official schema used to build eve.
2. If a client requests an unsupported version, including draft v2, the adapter must negotiate according to ACP: respond with the latest version it supports rather than claiming the requested version.
3. The adapter must not advertise draft or unstable capabilities.
4. `initialize` must report the installed eve version and an eve-owned implementation name.
5. Advertised capabilities must be derived from implemented, tested behavior. Omitted capability fields must not be interpreted internally as enabled.
6. Client authentication methods, filesystem, terminal, and client-provided MCP capabilities must not be advertised.
7. Unknown extension fields must be ignored where ACP and JSON-RPC require forward compatibility; they must never implicitly enable behavior.

A compatibility test must cover a client that requests version 2 and either continues using the negotiated v1 response or disconnects cleanly.

## Session requirements

### R4: ACP session identity

1. `session/new` must allocate an opaque adapter-owned ACP session ID and one independent `ClientSession`.
2. An ACP session ID must not be an eve runtime session ID. The eve ID does not exist until the first accepted prompt and may change after terminal reset behavior.
3. Session mappings may be process-local for the first release and must be discarded when the stdio connection ends.
4. Requests naming an unknown or closed ACP session must fail before dispatching model work.
5. The adapter must permit different ACP sessions to execute concurrently.
6. Prompts within one ACP session must be single-flight. An overlapping `session/prompt` for the same session must receive a deterministic busy error; it must not be queued invisibly or start a second eve session.

### R5: workspace declaration

1. In local mode, `session/new.cwd` must be absolute and resolve, after symlink normalization, to the eve application root selected at process startup.
2. A mismatched local `cwd` must fail session creation. In URL mode, `cwd` is untrusted client metadata: it must not select an application, change the server working directory, or grant filesystem access.
3. An empty `mcpServers` collection must be accepted. A missing collection must follow the pinned ACP schema's validation behavior.
4. A non-empty `mcpServers` collection must be rejected with an actionable unsupported-capability error before allocating runtime work or spawning any supplied command.
5. Additional workspace roots, if supplied through a stable ACP extension, must be rejected unless empty.

### R6: session closure

1. The adapter should advertise stable `session/close` support because `ClientSession.reset()` provides the corresponding terminal cleanup primitive.
2. Closing an idle session must reset its eve session when one exists, remove the ACP mapping, and prevent later reuse of the ACP ID.
3. Closing a session with an active prompt must cooperatively cancel it, wait for settlement, reset it, and then remove the mapping.
4. Repeated close requests must have deterministic already-closed or unknown-session behavior and must not affect a newer session.
5. Adapter shutdown must apply equivalent cleanup to all owned sessions without treating normal process termination as an agent failure.

## Prompt requirements

### R7: accepted content

1. The first release must accept one or more ACP text content blocks and preserve their order.
2. Empty prompt content must fail before calling `ClientSession.send()`.
3. Image, audio, embedded resource, file, and unknown content blocks must fail explicitly. They must not be omitted, stringified, or replaced with placeholders.
4. Text must be passed as user content without adding editor, Buzz, ACP, or framework policy to the user's message.
5. Support for additional content may be added only with explicit size limits, conversion semantics, capability advertisement, and focused tests.

### R8: prompt lifecycle

1. `session/prompt` must call `ClientSession.send()` and consume the resulting event stream through the current logical prompt boundary.
2. The request must remain open while the eve turn is active or parked on a supported human-input request.
3. An ordinary `session.waiting` or `session.completed` boundary must return ACP `end_turn`.
4. A confirmed eve cancellation boundary must return ACP `cancelled`.
5. Token or request limits may return their matching ACP stop reasons only when the eve event stream identifies that reason unambiguously; otherwise they must remain structured failures.
6. `turn.failed`, `session.failed`, stream corruption, authentication failure, and unsupported HITL must produce JSON-RPC errors with stable eve-owned codes and structured details. They must not be reported as `end_turn`.
7. The adapter must finish consuming or deliberately cancel the current stream before accepting another prompt for the same session.
8. Stream reconnect behavior must use the public client's cursor semantics and must not duplicate ACP updates after reconnect.

## Event projection

### R9: ordering and identity

1. ACP updates must preserve the observable order of eve events.
2. Adapter-generated message and tool IDs must be stable within the ACP session and deterministic across stream reconnection for the same eve event.
3. The adapter must not expose eve-only continuation tokens, credentials, internal workflow handles, or raw adapter state in ACP metadata.
4. Unknown eve events may be omitted only when they have no ACP-visible semantic effect. Failures and terminal boundaries must never be omitted.

### R10: minimum projection

| eve event                            | Required ACP v1 projection                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `message.appended`                   | `agent_message_chunk`, preserving text delta order                                        |
| `reasoning.appended`                 | `agent_thought_chunk` when reasoning is client-visible                                    |
| `actions.requested`                  | `tool_call` with stable call ID, title, kind, pending status, and representable raw input |
| observable tool start                | `tool_call_update` with `in_progress`                                                     |
| `action.result`                      | `tool_call_update` with completed or failed status and representable output               |
| confirmation `input.requested`       | `session/request_permission`                                                              |
| supported question `input.requested` | `elicitation/create` form request                                                         |
| known cumulative usage               | stable ACP `usage_update`                                                                 |
| `turn.cancelled`                     | cancellation settlement for the pending prompt                                            |
| `turn.failed` / `session.failed`     | structured failure for the pending prompt                                                 |

1. A `message.completed` event with `finishReason: "tool-calls"` must not be presented as the final conversational answer.
2. Tool output that is not valid ACP content must have a bounded textual representation and may include safe raw JSON where the schema permits it.
3. Secret-bearing authorization details must not be copied into tool output or `_meta` fields.
4. Usage must be emitted only when both the meaning and units of required counters are known. The adapter must not invent missing token counts.
5. Subagent activity may remain represented as the parent runtime tool call. Nested eve-only child streams are not required in the first release.

## Human-input requirements

### R11: permissions

1. An eve input request with `display: "confirmation"` and approve/deny options must map to `session/request_permission` associated with the corresponding tool call.
2. ACP option IDs must be adapter-owned and correlated to eve request and option IDs; client-provided IDs must not be trusted as eve IDs.
3. The adapter must offer `allow_once` and `reject_once` only. It must not offer persistent allow/deny choices because eve has no corresponding policy mutation.
4. A selected option must become the matching eve `InputResponse`; a cancelled permission must not be interpreted as approval.

### R12: elicitation

Stable ACP v1 form elicitation may represent a constrained subset of eve questions:

1. A text request with freeform input must map to one required string field.
2. A single-select request with fixed options and no freeform alternative must map to one required string enum field.
3. Returned values must map back to the original eve request and option IDs without matching on display labels alone.
4. Mixed freeform-plus-options, unsupported schemas, sensitive input, and ambiguous request shapes must fail with an actionable unsupported-HITL error.
5. The adapter must use elicitation only when the client advertises compatible form support. Otherwise the prompt must fail rather than wait forever or disguise a question as permission.
6. URL elicitation is not required for eve questions in the first release.

### R13: input batches

1. If one eve event requests multiple inputs, the adapter must preserve the batch boundary.
2. It may present compatible requests sequentially or concurrently, but it must gather the complete response set and submit it to eve in one `inputResponses` delivery.
3. Cancellation while a batch is open must cancel every outstanding ACP permission or elicitation request and must not submit a partial approval set.
4. Replayed stream events must not open duplicate client prompts for requests that already have pending or completed correlations.

## Cancellation requirements

### R14: turn cancellation

1. `session/cancel` must target only the active prompt for the named ACP session.
2. The adapter must call `ClientSession.cancel()` with the observed eve turn ID when available.
3. A cancellation received with no active prompt must be a successful no-op.
4. The pending `session/prompt` request must remain open until eve emits the cancellation settlement boundary.
5. The adapter must not accept a replacement prompt for that session until settlement, preventing a stale cancellation from reaching a newer turn.
6. Partial messages and completed side effects remain observable and must not be represented as rolled back.
7. Pending permission and elicitation requests must receive their ACP cancellation outcomes before the prompt returns `cancelled`.

### R15: JSON-RPC request cancellation

1. The adapter must handle stable `$/cancel_request` for adapter-owned outstanding requests.
2. Cancelling an active `session/prompt` request must cooperatively cancel the matching eve turn rather than merely abandoning its stream.
3. After settlement, request cancellation may return the standard JSON-RPC Request Cancelled error instead of the feature-specific `cancelled` stop reason.
4. Cancelling one request must not terminate the ACP session or affect unrelated sessions.
5. Unknown or already-settled request IDs must be harmless no-ops.

## Security requirements

### R16: trust boundaries

1. The local subprocess boundary is the ACP client authentication boundary for the first release. The adapter must not advertise ACP authentication methods.
2. Environment variables supplied by an ACP host, including platform identity variables, must not change protocol semantics or establish an eve human principal.
3. Prompt text and `_meta` values must never be treated as authenticated actor identity.
4. `cwd`, filesystem methods, terminal methods, and MCP descriptors must not expand eve sandbox or host access.
5. The adapter must use only connections, tools, credentials, and sandbox policy authored in the eve application.
6. Diagnostic errors returned over ACP must be useful without exposing secrets, authorization headers, environment values, or internal capability tokens.
7. No ACP client request may cause the adapter to execute an arbitrary client-supplied command.

## Process requirements

### R17: ownership and isolation

1. In local mode, the ACP parent process should supervise a headless local development-server child on an ephemeral loopback port.
2. The ACP parent alone must own protocol stdout. Child stdout and stderr must be redirected to the parent's stderr through bounded handling.
3. The child must never recursively start ACP mode.
4. Local mode must terminate only the server process it owns. It must not stop an independently running development server discovered on another port. URL mode must not start or stop a server.
5. Closing stdin, SIGINT, SIGTERM, or parent shutdown must cancel active adapter work and reap an owned local child process without leaving descendants.
6. Local rebuilds must retain ordinary eve generation semantics: an in-flight turn remains pinned, and the next turn uses the newest successful build.
7. A failed rebuild must be diagnostic only when the previous valid generation remains available; it must not corrupt an active ACP connection.

### R18: dependency boundary

1. ACP SDK types and runtime behavior must be wrapped behind eve-owned modules and must not become part of eve's public TypeScript API.
2. The official Apache-2.0 ACP implementation or generated schema should be the source of protocol truth; eve must not maintain ad hoc handwritten wire types.
3. Adding a new runtime dependency to `eve` should be avoided. If the SDK runtime is required, vendor the pinned stable v1 artifact through the existing compiled-dependency process with attribution.
4. Protocol schema upgrades must be deliberate and covered by compatibility tests; an upstream draft release must not silently alter the shipped wire contract.

## Quality requirements

### R19: test tiers

The implementation must include:

- unit tests for version negotiation, content conversion, event projection, ID correlation, HITL mapping, and error mapping using in-memory streams;
- integration tests for concurrent `ClientSession` handles, stream reconnection, cancellation settlement, and input-batch continuation;
- scenario tests for CLI conflicts, stdout purity, child boot failure, rebuild behavior, EOF, signals, and child reaping;
- a conformance fixture using the official ACP client SDK;
- a smoke test with at least one independent real ACP client.

Tests must not require external network services, platform credentials, or model-provider credentials unless they are placed in the existing CI-only end-to-end tier.

### R20: documentation and release

1. Public documentation must show client configuration, supported capabilities, and shutdown behavior.
2. Documentation must clearly distinguish ACP chat/tool observability from editor workspace access.
3. Unsupported MCP, filesystem, terminal, content, session-resume, and remote-target behavior must be listed explicitly.
4. Because the published `eve` package changes, implementation must include a patch changeset.

## Manual validation

Use Zed as the primary user-facing validation client. Zed co-governs ACP, launches custom ACP agents directly, and exercises initialization, sessions, streamed updates, tools, permissions, elicitation, and cancellation through a real UI.

### Configure Zed

1. Build eve and ensure `pnpm exec eve` resolves from the application being tested.
2. Open the exact eve application root as the Zed workspace. The workspace must match the application root because `session/new.cwd` is intentionally validated.
3. Open **Agent Settings → External Agents → Add Agent → Add Custom Agent**.
4. Add this entry to Zed settings:

```json
{
  "agent_servers": {
    "eve-local": {
      "type": "custom",
      "command": "pnpm",
      "args": ["exec", "eve", "acp"],
      "env": {}
    }
  }
}
```

If the GUI process cannot find `pnpm`, replace `command` with its absolute path. Disable project-level Zed MCP servers for the initial validation: Zed may forward them in `session/new`, while the first adapter intentionally rejects non-empty `mcpServers`.

### Run the Zed validation sequence

1. **Basic prompt:** Ask the agent to return a known sentence. Confirm text streams progressively and the turn ends normally.
2. **Tool lifecycle:** Use a deterministic authored tool. Confirm Zed renders one stable tool call moving through pending, running when observable, and completed or failed states.
3. **Approval:** Trigger a tool requiring confirmation. Test approve and deny in separate turns and confirm each response resumes the same logical eve prompt.
4. **Elicitation:** Trigger one fixed-choice `ask_question` and one freeform text question. Confirm Zed renders the appropriate controls and the original turn resumes with the submitted answer.
5. **Cancellation:** Start a deliberately slow turn, cancel it from Zed, and immediately submit another prompt after cancellation settles. Confirm the first returns cancelled and no stale cancellation reaches the second.
6. **Concurrent sessions:** Open two Zed agent threads and prompt both concurrently. Confirm independent history, tool IDs, and completion.
7. **Rebuild:** Change the authored agent while Zed remains connected. Confirm in-flight work stays on its pinned generation and the next turn uses the newest successful build.
8. **Close and shutdown:** Close a thread, then close Zed or terminate the ACP process. Confirm session cleanup and that the supervised development server leaves no child processes.
9. **Negative boundaries:** Separately verify that a mismatched workspace root, non-empty MCP configuration, and unsupported content fail clearly before model work while protocol stdout remains valid.

Capture Zed's ACP logs for any failure and compare them with the adapter's stderr. Neither log should contain credentials or continuation tokens.

### Use acpx for repeatable iteration

Before or alongside Zed, use `acpx` as a fast headless ACP client:

```sh
npx acpx@latest \
  --agent 'pnpm exec eve acp' \
  exec 'Reply with exactly: ACP works'
```

Run the command from the eve application root. In an eve source checkout, for example, first run `cd apps/fixtures/weather-agent`; the monorepo root does not provide an `eve` executable. `acpx` launches `pnpm exec eve acp` itself, so do not start a separate ACP process first. Use named sessions and cancellation to exercise concurrency without the editor UI:

```sh
npx acpx@latest --agent 'pnpm exec eve acp' -s first 'Start a slow task'
npx acpx@latest --agent 'pnpm exec eve acp' -s second 'Reply immediately'
npx acpx@latest --agent 'pnpm exec eve acp' -s first cancel
```

`acpx` is an additional smoke client, not the protocol oracle. Automated conformance remains pinned to the official ACP SDK and schema. The recommended validation order is:

1. official SDK conformance tests;
2. `acpx` scripted smoke tests;
3. the full Zed sequence above;
4. Buzz BYOH compatibility testing in its separate integration scope.

## Acceptance criteria

The adapter is ready when all of the following are true:

- An ACP v1 client can launch `eve acp`, initialize, create two sessions, and run them concurrently. The same client can launch `eve acp <url>` and receive equivalent ACP behavior from an authenticated deployed eve agent.
- Prompts within one session remain single-flight.
- Text, reasoning, tool calls, tool results, permissions, supported elicitation, usage, failures, and cancellation preserve order and stable IDs.
- Cancellation cannot affect a later turn and returns only after eve settles the observed turn.
- Non-empty MCP configuration, mismatched `cwd`, and unsupported content fail before model work.
- Draft v2 negotiation never causes eve to advertise v2.
- Every stdout line remains valid JSON-RPC during boot, rebuild, failure, and shutdown.
- EOF and process signals clean up all adapter-owned sessions and processes.
- No client request grants host filesystem, terminal, arbitrary process, or unauthenticated principal access.
- Existing development modes remain behaviorally unchanged.
