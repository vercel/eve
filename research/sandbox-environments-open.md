---
issue: TBD
status: draft
last_updated: "2026-09-16"
---

# Sandbox environments and provider sessions

## Decision

Authors configure an immutable provider environment, then open its sandbox for the current eve session:

```ts
export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await sandbox.run({ command: "pnpm install --frozen-lockfile" });
  },
});

export default defineSandbox(async ({ session }) => {
  const sandbox = await environment.open({ networkPolicy: "deny-all" });
  await sandbox.writeTextFile({ path: ".eve/session", content: session.id });
  return sandbox;
});
```

`environment.open()` returns the exact `RuntimeSandboxSession` selected by the sandbox definition. It is the only author-facing environment operation.

## Provider-owned options and hooks

Environment configuration and live options are single provider-owned objects. Core passes them unchanged and never reserves, injects, extracts, or interprets fields such as `prepare`.

Omission remains `undefined`. Providers normalize optional input themselves. Objects with required fields remain required; positional arguments are not supported.

Providers own callback names, argument types, ordering, and lifecycle timing. A snapshot provider may expose `prepare(sandbox)`. A custom provider may expose a start-only callback in its open options. Built-in providers instead initialize the live sandbox in `defineSandbox()` after `open()`. Dockerfile image providers expose no authored preparation callback when immutable setup belongs in the Dockerfile.

Provider callbacks and runtime callback arguments are never stored in prepared artifacts. Provider-defined session-hook return values may enter serialized provider session state only when `resume()` needs them.

## Public sandbox sessions

`SandboxSession` is an I/O-only surface used by preparation and provider-defined session hooks. It contains process and file operations and eve-owned `resolvePath()`. Providers express additional capabilities in their exact session type. It has no `id`, `stop()`, or `delete()`.

`environment.open()` returns the provider-specific session type plus `stop()` and `delete()`. Core erases that exact type only at the heterogeneous runtime registry boundary.

Authors use `ctx.session.id` for durable eve identity. Provider-native IDs and core artifact keys remain private. `resolvePath()` remains unchanged: relative paths resolve beneath `/workspace`, and absolute paths pass through.

`setNetworkPolicy()` is required on the session types returned by dedicated Vercel, Docker, and microsandbox environments. just-bash and providers that reuse one native network boundary omit it from their session types and require policy at creation time.

## Provider contract

```ts
interface SandboxProviderImplementation<OpenOptions, Artifact, SessionState, Session> {
  prepare(context: SandboxProviderPrepareContext): Promise<Artifact>;

  start(
    context: SandboxProviderSessionContext,
    options: Readonly<OpenOptions> | undefined,
    artifact: Readonly<Artifact>,
  ): Promise<{
    handle: SandboxProviderHandle<Session>;
    state: SessionState;
  }>;

  resume(
    context: SandboxProviderSessionContext,
    artifact: Readonly<Artifact>,
    state: Readonly<SessionState>,
  ): Promise<SandboxProviderHandle<Session>>;
}

interface SandboxProviderSessionContext {
  readonly session: SandboxSelectorContext["session"];
  readonly storagePath: string;
}

interface SandboxProviderHandle<Session> {
  readonly sandbox: Session;
  onSessionStop(): Promise<void>;
  onRuntimeShutdown(): Promise<void>;
  onSessionDelete(options?: SandboxDeleteOptions): Promise<void>;
}
```

`Artifact` and `SessionState` are JSON-compatible provider-owned types. Core erases exact types only at the heterogeneous runtime registry boundary.

### Preparation

`prepare()` is mandatory and returns only the complete artifact. A provider with no build work may return `null`. Cache reuse is provider logging, not shared return data.

Managed workspace and skills are available only during preparation. The artifact captures their files or exact provider references. Runtime never rebuilds, rehydrates, repairs, or reinterprets build inputs.

Core keeps its artifact storage key private and passes the artifact directly to `start()` and `resume()`. There is no `base | prepared` source union.

### Provider-discovered files

Preparation context exposes a tracked filesystem scoped to the authored sandbox directory:

```ts
interface SandboxProviderFiles {
  list(): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}
```

Providers discover their own Dockerfiles and build contexts through this surface. Core tracks, hashes, and watches reads. Providers do not receive the application root for authored file discovery.

Provider contexts expose `storagePath` for private caches, local VM state, and temporary files. Core owns project layout.

### Start and resume

Core evaluates `defineSandbox()` and calls `start()` when no serialized provider session state exists. After initialization succeeds, core checkpoints the selected provider and state. Later workflow steps and process restarts bypass the selector and call `resume()` directly. Failed initial selector code deletes the newly started handle and leaves no durable state, so a later access can retry initialization.

`start()` receives provider-owned open options and the exact artifact. `resume()` receives only the current session context, the target deployment's exact artifact, and persisted provider state. Open options and callbacks are never serialized or reconstructed by core. Credentials, clients, fetch implementations, and signals needed for lookup belong to environment/provider configuration rather than start-only open options. A provider must include any immutable option-derived data needed for reconnection in its own JSON-compatible state.

Provider state is immutable after `start()` in this contract. `resume()` reconnects or restarts persisted native state but does not recreate missing native compute from unavailable callbacks. If native state is gone, resume fails. Deletion clears provider state; the next access evaluates the selector and starts again.

During deployment handoff, the target provider validates state against its current implementation and artifact. Incompatibility rejects activation, leaving the existing owner on its current deployment. Core does not persist old artifacts or migrate provider state.

### Minimal session state

Provider session state contains only values that cannot be cheaply and deterministically recovered, such as an opaque platform ID. It does not duplicate prepared artifacts, credentials, clients, callbacks, or derivable hashes. It may contain immutable option-derived values required for direct resume. Providers version and validate their state in `resume()`.

Provider state is returned only by `start()` and is immutable for the durable session. Handles do not expose a later state-capture operation or create/restore union.

### Lifecycle hooks

Provider-handle hooks describe the eve event, not a required native effect:

- `onSessionStop()` handles authored `sandbox.stop()` while preserving provider session state.
- `onRuntimeShutdown()` releases a process-local attachment without changing durable state.
- `onSessionDelete()` handles authored deletion; core clears provider state after it succeeds.

Dedicated providers normally map these hooks to native stop or delete. Providers that reuse native resources map them to logical detachment. Core has no native ownership flag or provider-owned lifetime branch.

## Native identity

Core does not derive provider instance keys or native names. Each provider derives identity from the inputs it owns.

Dedicated providers include `session.id`:

```text
session ID
+ validated artifact
+ immutable environment options
+ serialized immutable open-option identity
+ provider contract version
→ native identity
```

A reused provider excludes the eve session ID:

```text
validated artifact
+ immutable environment options
+ provider contract version
→ reused native identity
```

Identity derivation excludes credentials, signals, clients, callbacks, logs, and mutable turn data. Providers canonicalize supported values and reject unsupported non-serializable identity inputs.

Core does not expose a universal generation or revalidation field. It does not pass its internal artifact key to providers. Compatibility is the provider-derived identity; no `sandboxConfig` or second provider manifest is added.

## Dedicated Vercel behavior

The Vercel provider retains the useful pre-redesign behavior inside its own implementation:

1. `start()` derives a deterministic native name from `session.id`, the validated artifact, environment options, open options, and a Vercel contract version.
2. It looks up that name and creates only when absent.
3. The selector initializes the live sandbox after `open()` before returning it.
4. It returns immutable state such as `{ version: 1, sandboxName }`.
5. `resume()` looks up that name directly from state. If native compute is missing, resume fails rather than recreating callback side effects.

Snapshot-unavailable replacement behavior remains provider-owned. No author controls the native name.

## Reused providers

Cross-session native reuse is not a core feature. A custom provider may derive native identity without `session.id` while returning one session-owned logical view per eve session.

The experimental reused Vercel provider uses the same prepared image and Drive mechanics but has a distinct provider contract. It exposes immutable shared network policy and no mutable `setNetworkPolicy()`. Its lifecycle hooks do not tear down native compute used by other sessions.

Concurrent creation, initialization recovery, attachment accounting, active-handle deduplication, and garbage collection remain provider implementation details. Core tracks one logical handle per eve session.

## Default selection

`defineSandboxProvider()` has one implementation contract and no `select` escape hatch. `DefaultSandbox` is an explicit facade that probes the host and returns a concrete Vercel, Docker, microsandbox, or just-bash environment. Every concrete provider uses `defineSandboxProvider()`.

Core exposes no public environment `kind`. Providers discover their own preparation inputs through the tracked filesystem.

## Observable invariants

- Authors use only `environment.open(options)`.
- Environment and open options are provider-owned single objects; omission remains `undefined`.
- Core invokes provider `prepare()`, `start()`, and `resume()` directly.
- Prepared artifacts are immutable, complete, and consumed directly at runtime.
- A successfully initialized selector runs once; resume bypasses it and may repeat across process restarts.
- Provider session state is immutable, minimal, JSON-compatible, and provider-validated.
- Existing sessions retain their pinned generation across deployment handoff or remain on the old deployment when incompatible.
- Core contains no provider-native identity, sharing, ownership, or repair branch.
- Public sandbox sessions expose operations rather than provider or core identity.
