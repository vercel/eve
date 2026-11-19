---
issue: https://github.com/vercel/eve/issues/6277
status: in-progress
last_updated: "2026-11-19"
---

# Offloading large tool results to the sandbox

> **AI status:** Written entirely by AI; human review pending.

Large tool results (an MCP call returning 680 KB of JSON is about 190,000 tokens) fill the context window and are re-sent on every later model call in the turn. This doc proposes `offloadSandbox`, a `toModelOutput` helper that writes a result over a token budget to a sandbox file and gives the model a short note it can follow up on with jq. Code references are to `vercel/eve` `main` at `dfc71e3`.

## The measurement

| What                                                               | Bytes     | Tokens (o200k) |
| ------------------------------------------------------------------ | --------- | -------------- |
| Full result, `GET /repos/vercel/eve/issues?state=all&per_page=100` | 680,088   | 190,565        |
| The note the model gets instead                                    | about 600 | 157            |
| `jq '.[] \| {number,title,state}'` output for all 100 items        | 11,391    | 2,825          |

_Counted with `gpt-tokenizer`'s `o200k_base` encoding. Claude's tokenizer differs, but by a constant factor on both sides._

In a turn of 10 model calls, the full result costs about 1.9M input tokens (cached tokens bill cheaper, but still count against the window). The note plus one jq slice costs under 30,000.

## How eve handles a tool result today

Every tool result becomes model output in one function, `toolCallModelOutput` (`harness/tool-call-io.ts:69-96`). Both the in-conversation path (`harness/call-executor.ts:250`) and the out-of-conversation invoke path (`execution/invoke-tool.ts:342`) call it, and authored, built-in and connection tools all reach it. It applies the tool's own `toModelOutput` if it has one, else sends the output as text or JSON.

- Authored tools are wrapped in `createRegisteredHarnessToolDefinition` (`execution/node-step.ts:186-220`), which copies the author's `toModelOutput` (`:217`). The public type is `ToolDefinition` (`tools/definition.ts:268`, `toModelOutput` at `:313`).
- MCP and OpenAPI tools are deferred catalog entries. When the model calls `eve__tool`, the catalog rewrites the call to the target tool and its definition (`execution/catalog/step-catalog.ts:109-121`, `harness/execute-call.ts:72-74`), so the result is the connection tool's own result, with `connectionToolModelOutput` as its `toModelOutput` (`execution/catalog/connection-entry.ts:78`).
- MCP results are picked by `toConnectionToolResult` (`runtime/connections/tool-result.ts:14-40`): all blocks if any isn't text, else `structuredContent`, else parsed JSON text, else raw text. A `resource_link` becomes the text "Resource link: name uri" and is never fetched (`:94-98`).
- No size check runs on authored or connection results. Compaction's `capToolResults` (`harness/compaction/engine.ts:388`) cuts old results to `TRANSCRIPT_PAYLOAD_LIMIT`, 2,000 characters (`harness/compaction/prompt.ts:167`), only once history crosses the threshold.

Built-in tools handle size themselves, with the limits in `execution/sandbox/truncate-output.ts` (50 KiB, 2,000 lines):

- `bash` keeps output files under `/tmp/.eve/jobs/<jobId>/` when output passes the limit and appends "; full output: <dir>/stdout" (`execution/sandbox/bash.ts:25,121-122,276-279,321-322`). Tests pin that text (`bash.scenario.test.ts:45-46`, `bash.test.ts:80`).
- `read_file` stops at the byte limit and returns `truncated` and `nextOffset` (`read-file.ts:123-145`). `glob` and `grep` cut with an inline notice (`glob-tool.ts:82-84`, `grep-search.ts:227`).
- `web_fetch` cuts the head with `truncateHead` and no notice, and the rest is lost (`execution/web-fetch/execute.ts:89`).

## Proposed behavior

### Configuration

```ts
import { offloadSandbox } from "eve/tools";

defineMcpClientConnection({
  url,
  toolCall: { toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 }) },
});

defineTool({
  ...webFetch,
  toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 }),
});
```

- `ToolDefinition.toModelOutput` (`tools/definition.ts:313`) becomes `(output: TOutput, ctx: ToolModelOutputContext) => ToolModelOutput | Promise<ToolModelOutput>`. `ctx` carries `getSandbox`, `callId`, `toolName` and `defaultModelOutput`. `getSandbox()` resolves `undefined` when the agent has no sandbox, and `defaultModelOutput(output)` is the projection eve applies when a tool sets no `toModelOutput`, which is `connectionToolModelOutput` for a connection tool. Existing one-argument functions keep working.
- `ConnectionToolCallDefinition` (`public/definitions/connections/tool-call.ts:27-30`) gains the same `toModelOutput`, so `defineMcpClientConnection` and `defineOpenAPIConnection` both get it. It receives the connection tool's raw result.
- `offloadSandbox({ maxOutputTokens, toModelOutput? })` returns a `toModelOutput` function. The optional inner `toModelOutput` is applied first, and the budget is checked on its result. Left out, the raw value goes to the model under the budget. For `web_fetch`, `gh`, `grep` and `glob` that is the right result, because over the budget their cut is replaced by the file. For a connection, `ctx.defaultModelOutput` is eve's own `connectionToolModelOutput`. Size is the projected output, estimated as UTF-8 bytes / 4.
- Built-in and extension tools are overridden by spreading the exported definition into `defineTool` (`docs/concepts/built-in-tools.md:58-72`), so they need no new option.

### Past the budget, with or without a sandbox

- With a sandbox: eve writes the file described below and the model gets the note.
- Without a sandbox: `offloadSandbox` returns the inner projection unchanged and logs one warning per session. eve never cuts a result to fit.
- Where the result is kept is the helper's choice. A Blob helper can come later with the same shape; it also needs a way for the model to read the result back, so it is out of scope.

### Built-in and extension tools that cut inside `execute`

These cut their result before `toModelOutput` runs, so `offloadSandbox` would only see the cut copy. PR 2 moves each cut into the tool's default `toModelOutput`:

- `web_fetch`: `truncateHead` at 50 KB, rest dropped (`execution/web-fetch/execute.ts:89`).
- `gh` in `eve-git`: keeps the last `MAX_OUTPUT_BYTES = 100_000` (`eve-git/extension/lib/github-shell.ts:150,517-522`).
- `grep` and `glob`: 50 KB with a notice (`grep-search.ts:227`, `glob-tool.ts:82-84`).

After the move, `call.settled` carries the full result for these tools. Unchanged: `bash` (job files under `/tmp/.eve/jobs`, also used by running background jobs), `read_file` (pages by offset), and the browser and desktop extension tools (their own `toModelOutput` for screenshots and snapshots).

### What gets written

- The file holds the tool's raw output, before `toModelOutput`, so jq sees the real data. JSON values are written as `.json`, compact as received. A string result is written as `.txt`.
- Results with image, audio or binary blocks keep today's path. jq can't read them, and the file-part rules already bound their size.
- Path: `/tmp/.eve/tool-results/<tool name>-<toolCallId>.<ext>`, beside `bash`'s job directory.
- Errors stay inline and are never saved.

### The note the model sees

```text
The result of github__list_issues was saved to
/tmp/.eve/tool-results/github__list_issues-call_abc.json
(680,088 bytes, about 170,000 tokens).
It is a JSON array of 100 objects with the keys: url, number,
title, user, labels, state, ... (34 keys).
Read parts of it with jq, head or read_file.
```

The shape line is computed, not a raw preview: the top-level type, the array length or object keys, and the keys of the first item, capped at about 400 characters. For text, the note includes the first 20 lines instead.

### Where the code changes

- `toolCallModelOutput` (`harness/tool-call-io.ts:69-96`) is where every result becomes model output. It passes `ctx` to `toModelOutput`, built from the running context with `loadContext()` and `SandboxKey`, as `execution/invoke-tool.ts:172` does. `offloadSandbox` writes with `SandboxSession.writeTextFile` (`shared/sandbox-session.ts:100-112`).
- `connectionEntry` (`execution/catalog/connection-entry.ts:61-78`) uses the connection's `toolCall.toModelOutput` when set, wrapping `connectionToolModelOutput`.
- The full value stays on the call's settled event (`action.result`), so channels, hooks and traces still see it. History stores only the note, which keeps the prompt cache stable.

### No sandbox, and a sandbox that hasn't started

- No sandbox configured: the result passes through unchanged, and eve logs a warning once per session.
- Sandbox configured but not started: the write starts it. The model needs the sandbox to read the file anyway.
- Sandbox lost later (timeout, new session): the file is gone and `read_file` fails. The model can rerun the tool. A follow-up could restore it from the session stream, as eve issue #1040 proposes.

## Alternatives

- A default token cap (eve issue #5924, closed PR #6252). It loses data, and the maintainers closed it as a product decision.
- A `maxOutputTokens` option on `defineTool` and connections. It fixed one behavior in config; a `toModelOutput` helper does the same and leaves room for other helpers. It also resolves eve issues #6277 and #905, which ask for `toModelOutput` on connections.
- A `resultFile` option naming the mechanism. It modeled how eve stores the overflow rather than the budget itself.
- Reading the full output back from the session stream with a new `expand_tool_result` tool (eve issue #1040). Works without a sandbox, but the model pages through text instead of running jq.
- A per-call flag on `eve__tool`. It only reaches deferred catalog tools (MCP and OpenAPI), so it can't be the one mechanism for all tools. The budget covers the same need for every tool.
- A model-set argument added to every tool's own schema. It changes every tool's input and costs tokens on every request.

## Prior art

- Claude Code saves an MCP result over 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`) to a file and gives the path; it also saves any text result over 50,000 characters, and Bash output over its limit, into `tool-results/` with a 2 KB preview. [MCP output limits](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings), [Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- Goose writes MCP text responses over 200,000 characters to a temp file and returns the path. [large_response_handler.rs](https://github.com/block/goose/blob/main/crates/goose/src/agents/large_response_handler.rs)
- GitHub Copilot CLI saves output over 30 KB to a temp file. [copilot-cli#1732](https://github.com/github/copilot-cli/issues/1732)
- Codex CLI truncates (head and tail, `tool_output_token_limit`, per-tool `output_token_limit`) and does not save to a file. [codex#6426](https://github.com/openai/codex/issues/6426)
- Anthropic measured 150,000 to 2,000 tokens (98.7%) by keeping intermediate MCP results in the execution environment. [Code execution with MCP](https://www.anthropic.com/research/code-execution-with-mcp)
- The MCP spec (2025-06-18) has `resource_link` for a server to return a reference instead of content, and `structuredContent` for JSON results. [Tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). eve doesn't fetch resource links today; that's a separate gap.

## Real-path test

Two agents with a sandbox: one with an MCP connection to a test server whose tool returns the 680 KB issues JSON, one with an authored `defineTool` that returns the same JSON, both with `toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 })`. The test passes when the model's next request carries the note (under 300 tokens) rather than the JSON, the file exists in the sandbox with identical bytes, and the model answers "how many of these issues are open?" correctly by running jq. Before the change, the same request carries about 190,000 tokens of tool result. A third case runs the authored tool on an agent with no sandbox and checks the model gets the full result unchanged and the warning is logged. A fourth case overrides `web_fetch` with `offloadSandbox` on a page over 50 KB and checks the file holds the whole page.
