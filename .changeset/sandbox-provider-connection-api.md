---
"eve": minor
---

**Breaking for custom sandbox providers.** `defineSandboxProvider()` now takes a byte-level `SandboxConnection` (`spawn`, `readFile`, `writeFiles`, `removePath`, `stop`, optional `close` and `extensions`), and eve derives the full sandbox session from it. Built-in providers are unchanged. See the [custom sandbox providers guide](https://eve.dev/docs/sandbox/custom-providers). To migrate a provider:

- Return `{ connection, state }` from `start()` and a connection from `resume()`. `onSandboxStop()` and `onRuntimeShutdown()` become `connection.stop()`, and `onSandboxDelete()` folds into `onSessionEnd()` with `reason: "deleted"`.
- Replace `ctx.resources` and `ctx.sourceRevision` with `ctx.templateKey()` and `ctx.populate()`, and remove your own `prepare` option, which eve now runs. `environment()` receives `{}` instead of `undefined` when no options are passed. Set `toolSessions: true` to support keyed `invokeTool` calls.
- Rename `SandboxPreparedArtifact` to `SandboxJson`, `SandboxProviderSessionContext` to `SandboxSessionContext`, and `SandboxProviderPrepareContext` to `SandboxPrepareContext`. `SandboxProviderHandle` and the `SandboxProviderResource*` and `SandboxProviderTargetFile` types are removed, as is `ctx.host`.

`eve/sandbox/provider` also exports `SandboxSessionGoneError`, `SandboxTemplateNotProvisionedError`, and `SANDBOX_AGENT_ENV`. In `eve/sandbox`, `SandboxSession` gains a required `writeFiles()`, so hand-built sessions such as test doubles need one, and `SandboxNetworkPolicy` is now an eve-owned type rather than the Vercel Sandbox SDK's `NetworkPolicy`.
