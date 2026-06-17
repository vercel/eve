# eve

## 0.11.1

### Patch Changes

- e7cdefd: Handle missing sandbox template and session state more gracefully across Vercel, Microsandbox, and Docker backends. Eve now treats stale Vercel template references, missing Microsandbox session/template snapshots, and Docker template image races as recoverable provisioning misses so the runtime can rebuild or create a fresh sandbox automatically.

## 0.11.0

### Minor Changes

- 31fb09f: Remove the `withEve` Vercel output opt-out option. Next.js projects now skip generated Vercel Build Output writes when no linked Vercel project or existing output context is detected.

### Patch Changes

- ff80e38: The `eve eval --verbose` help text now refers to `t.log` (the actual eval context logging API) instead of the outdated `ctx.log`.
- f6c5932: Emit a `rejected` `action.result` stream event when a tool call is denied at a HITL approval gate. Denied calls previously left no trace in the session stream (the denial lived only in model history), so consumers like observability never saw the tool call resolve. The `action.result` status union now includes `rejected`, and the message stream version is bumped to `16`.

## 0.10.0

### Minor Changes

- c2ac540: Initial public release of the Eve framework
