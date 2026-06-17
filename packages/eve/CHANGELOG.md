# eve

## 0.11.4

### Patch Changes

- e5b777b: Resolve AI Gateway OIDC readiness through Vercel's token resolver so `eve dev` recognizes projects linked by the Vercel CLI without requiring an environment pull or showing a missing-credentials setup issue.

## 0.11.3

### Patch Changes

- 1e2e8ef: Standardize the product name as `eve` across documentation, CLI output, diagnostics, generated text, and runtime messages.
- ea35d0e: Changing a model or configuring its provider in `/model` now returns to the prompt and prints the result there. Cancelling or choosing an external provider still returns to the menu.
- ea35d0e: The dev TUI now shows `/vc` or `/login` before `/model` when Vercel authentication is blocking model setup.
- 29e27b8: Run `vercel link` non-interactively when connecting a project via the dev TUI `/model` menu (and `eve link`). The link is already fully specified by the team and project picked in the TUI, so the CLI no longer inherits a TTY and can no longer surface its interactive prompts (such as the agent/MCP setup question), which previously corrupted the TUI.

## 0.11.2

### Patch Changes

- dbac239: Fix dynamic connection tools so approval gates from OpenAPI and other connection-backed tools are preserved when the tools are exposed to the model. Calls to connections with `approval: always()` now correctly park for HITL approval before execution.

## 0.11.1

### Patch Changes

- e7cdefd: Handle missing sandbox template and session state more gracefully across Vercel, Microsandbox, and Docker backends. eve now treats stale Vercel template references, missing Microsandbox session/template snapshots, and Docker template image races as recoverable provisioning misses so the runtime can rebuild or create a fresh sandbox automatically.

## 0.11.0

### Minor Changes

- 31fb09f: Remove the `withEve` Vercel output opt-out option. Next.js projects now skip generated Vercel Build Output writes when no linked Vercel project or existing output context is detected.

### Patch Changes

- ff80e38: The `eve eval --verbose` help text now refers to `t.log` (the actual eval context logging API) instead of the outdated `ctx.log`.
- f6c5932: Emit a `rejected` `action.result` stream event when a tool call is denied at a HITL approval gate. Denied calls previously left no trace in the session stream (the denial lived only in model history), so consumers like observability never saw the tool call resolve. The `action.result` status union now includes `rejected`, and the message stream version is bumped to `16`.

## 0.10.0

### Minor Changes

- c2ac540: Initial public release of the eve framework
