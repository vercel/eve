---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: in-progress
last_updated: "2026-10-22"
---

# Low-level sandbox provider API

## Summary

Replace the public `defineSandboxProvider()` contract with a smaller one that
custom backends and eve's built-in providers (Vercel Sandbox, Docker,
just-bash, and a later host provider) all use. A backend implements a
byte-level `SandboxConnection` and a lifecycle of `prepare`, `start`, `resume`,
and `onSessionEnd`. eve derives the full `SandboxSession`, seeds build
instances, hashes template keys, and maps stop, delete, and shutdown onto that
lifecycle.

Related: #3502 (third-party provider), #3717 (typed `prepare` sandbox), #4774
(batched writes), #5020 (custom session methods).

## Problem

Verified against `main` at `a2c6d64ed3`:

- **Custom providers write the whole session.** `SandboxProviderHandle.sandbox`
  must implement all ten `SandboxSession` methods. The builder that derives them
  from primitives, `buildSandboxSession`, is internal. The e2e `custom-provider`
  fixture hand-writes all ten.
- **Three stop-like handle hooks.** `onSandboxStop`, `onRuntimeShutdown`, and
  `onSandboxDelete`. Docker and Vercel map the first two to the same stop call,
  and each built-in's `onSandboxDelete` repeats what its `onSessionEnd` does.
- **Recovery and capabilities are private.** `SandboxSessionGoneError` (#5117)
  is not exported. Keyed `invokeTool` sandboxes require a private `WeakMap`
  marker (`withToolSessionSandboxes`). Batched writes use the private
  `SANDBOX_WRITE_FILES` symbol.
- **Built-ins duplicate the same work.** Each one hashes template keys from
  resource keys and `sourceRevision`, seeds workspace and skill files before
  authored `prepare`, defines `resolvePath`, and builds the handle trio.
- **Third-party types leak.** Session types derive from the AI SDK,
  `SandboxNetworkPolicy` aliases `Vercel.NetworkPolicy`, `eve/sandbox/vercel`
  re-exports `Drive`, and just-bash options expose `CustomCommand` and
  `IFileSystem`.

## Constraints

- **Build-time baking stays.** Vercel snapshots, Docker images, and just-bash
  template directories capture workspace and skill files plus authored `prepare`
  during `eve build` (or first access in `eve dev`). Prepared artifacts are JSON
  in `sandbox-prepared-artifacts.json` and ship with the deployment. Snapshot
  providers cannot seed skills on first open.
- **A running sandbox keeps its build.** The artifact applies only when `start()`
  creates the sandbox. `resume()` receives the current deployment's artifact but
  reconnects existing native state.
- **Contract from #5132 and #5117.** `start()` is an idempotent upsert keyed by
  the session. `onSessionEnd(ctx, state | null, { reason })` is required and
  idempotent. `resume()` may throw `SandboxSessionGoneError`.
- **Core writes dynamic skills at runtime** through the session (`writeSandboxFiles`
  in `shared/skill-package.ts`).
- **Migration is invisible to running sessions.** Native session names, session
  state shapes, and template keys stay byte-identical.

## Proposal

### Layer 0: eve-owned session types

`eve/sandbox` declares its own `SandboxSession`, run, spawn, process, read,
write, and network-policy types instead of deriving them from `ai` or
`@vercel/sandbox`. A type test asserts that `SandboxSession` stays assignable to
the AI SDK's `Experimental_SandboxSession` method set. `SandboxSession` gains a
public `writeFiles()`; a batch is not atomic, and a rejected batch may leave
earlier files written (#4774).

```ts
export interface SandboxProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ readonly exitCode: number }>;
  kill(): Promise<void>;
}

export type SandboxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow?: readonly string[] | Readonly<Record<string, readonly SandboxNetworkRule[]>>;
      readonly subnets?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    };

/** Exactly one of `transform` (inject headers) or `forwardURL` (proxy the request). */
export type SandboxNetworkRule = { readonly match?: SandboxNetworkMatch } & (
  | { readonly transform: readonly { readonly headers?: Readonly<Record<string, string>> }[] }
  | { readonly forwardURL: string }
);

/** Each matcher sets exactly one of `exact`, `startsWith`, or `regex`. */
export interface SandboxNetworkMatch {
  readonly path?: SandboxNetworkMatcher;
  readonly method?: readonly string[];
  readonly queryString?: readonly { key?: SandboxNetworkMatcher; value?: SandboxNetworkMatcher }[];
  readonly headers?: readonly { key?: SandboxNetworkMatcher; value?: SandboxNetworkMatcher }[];
}
```

`SandboxNetworkPolicy` keeps the shape that today's `isSandboxNetworkPolicy`
validator accepts. The Vercel provider type-checks it against
`@vercel/sandbox`'s `NetworkPolicy` internally.

### Layer 1: the connection a backend implements

```ts
export interface SandboxConnection<Extensions extends object = {}> {
  /** Absolute; relative paths resolve from it and commands start in it. Defaults to `/workspace`. */
  readonly workspaceRoot?: string;
  spawn(options: {
    readonly command: string;
    readonly workingDirectory: string;
    readonly env: Readonly<Record<string, string>>;
    readonly abortSignal?: AbortSignal;
  }): Promise<SandboxProcess>;
  readFile(options: {
    readonly path: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
  writeFiles(options: SandboxWriteFilesOptions): Promise<void>;
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  /** Releases compute and keeps the sandbox's files. */
  stop(): Promise<void>;
  /** Releases what this process holds, such as a local interpreter, without touching the sandbox. */
  close?(): Promise<void>;
  /** Provider capabilities merged onto the session, such as `setNetworkPolicy`. */
  readonly extensions?: Extensions;
}
```

Each method has a fixed contract:

- `spawn` runs `command` as a Bash login-shell script (`bash -lc`) in
  `workingDirectory`, with the sandbox's environment plus `env`. `env` holds
  only the per-call variables. Aborting kills the process tree.
- `readFile` resolves to `null` only when the path does not exist. A directory
  or an unreadable path rejects. A backend returns bytes or a stream, whichever
  it has; eve normalizes both.
- `writeFiles` creates missing parent directories and overwrites existing files.
  It is the only write primitive. Every built-in already buffers each write
  before sending it, so a bytes-only primitive does not regress them.
- Every path a connection receives is absolute, and `workingDirectory` is
  always set. eve is the only owner of path resolution: relative paths and a
  relative or missing `workingDirectory` resolve from the connection's
  `workspaceRoot`, `/workspace` unless the connection declares another
  absolute directory. Every built-in keeps the default.

eve derives the rest of `SandboxSession`: `run` over `spawn`, binary and text
variants, encodings and line ranges, single-file writes over `writeFiles`, path
and working-directory resolution, abort-signal binding, and logging during
preparation. Extension members that collide with a `SandboxSession` member are
a type error (`never`), and eve throws on them at runtime.

### Layer 2: the provider lifecycle

```ts
export function defineSandboxProvider<
  EnvironmentOptions extends object,
  OpenOptions extends object | undefined,
  Artifact extends SandboxJson,
  State extends SandboxJson,
  Extensions extends object,
>(definition: {
  readonly name: string;
  readonly stateProtocolVersion?: number;
  environment(
    options: EnvironmentOptions,
  ): SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions>;
}): SandboxProvider<
  WithPrepareOption<EnvironmentOptions, SandboxSession & Extensions>,
  OpenOptions,
  SandboxSession & Extensions
>;

export interface SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions> {
  prepare(ctx: SandboxPrepareContext): Promise<Artifact>;
  start(
    ctx: SandboxSessionContext,
    options: Readonly<OpenOptions> | undefined,
    artifact: Readonly<Artifact>,
  ): Promise<{ readonly connection: SandboxConnection<Extensions>; readonly state: State }>;
  resume(
    ctx: SandboxSessionContext,
    artifact: Readonly<Artifact>,
    state: Readonly<State>,
  ): Promise<SandboxConnection<Extensions>>;
  onSessionEnd(
    ctx: SandboxSessionContext,
    state: Readonly<State> | null,
    options: {
      readonly reason: "completed" | "expired" | "failed" | "deleted";
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<void>;
  /** Set when sandboxes may outlive one keyed `invokeTool` call. See invariants. */
  readonly toolSessions?: true;
}

export interface SandboxSessionContext {
  /** Unchanged: `session.id` is the sandbox owner's id, which native names derive from. */
  readonly session: SandboxSelectorContext["session"];
  readonly kind: "session" | "tool-session";
  readonly storagePath: string;
  resolveProjectPath(path: string): string;
}

export interface SandboxPrepareContext {
  readonly files: SandboxProviderFiles;
  readonly storagePath: string;
  /** No workspace or skill files and no authored `prepare`. */
  readonly isEmpty: boolean;
  log(message: string): void;
  resolveProjectPath(path: string): string;
  templateKey(identity: SandboxIdentity): string;
  /** A stable read-only host directory with `workspace/` and `skills/`, when one exists. */
  resourcesDirectory(): Promise<string | undefined>;
  /** Seeds the connection's workspace root and `$HOME/.agents/skills`, then runs authored `prepare`. */
  populate(
    connection: SandboxConnection<object>,
    options?: { readonly mountedAt?: string },
  ): Promise<void>;
}

export type WithPrepareOption<Options extends object, Session> = Options &
  SandboxPrepareOption<Session>;

export interface SandboxPrepareOption<Session> {
  readonly prepare?: (sandbox: Session) => void | Promise<void>;
}
```

Type parameters are inferred from the returned implementation, so authors do
not pass five explicit generics. `environment()` takes a plain parameter, and
`SandboxPrepareContext` is not generic over the extensions, because TypeScript
cannot infer through a conditional rest tuple and fixes a type parameter as soon
as a context-sensitive method such as `prepare(ctx)` uses it. `State` comes from
`start()`'s return value when `start()` precedes `resume()`. `SandboxJson` is today's
`SandboxPreparedArtifact` under a name that fits both artifacts and state.

`ctx.session.id` keeps its current meaning: the id of the session that owns
the sandbox. For a subagent that shares its parent's sandbox, that is the
parent's id. For a keyed `invokeTool` call, it is the derived `tool_session_`
id. `kind` replaces the internal `isToolSessionId` check that Vercel uses
today.

`templateKey(identity)` returns exactly:

```ts
createSandboxProviderIdentity({
  ...identity,
  resources: { skills: skillsTreeKey, workspace: workspaceTreeKey },
  sourceRevision,
});
```

This is the same SHA-256 hex that each built-in computes today. `resources`
and `sourceRevision` are reserved, and eve throws if `identity` sets either one.
`SandboxIdentity` is whatever the hasher accepts: JSON values, `undefined`
(omitted), plain objects and arrays, and functions (hashed as
`function:<source>`). Circular values and other types reject. just-bash
includes its `customCommands` and `filesystem` functions, so its key stays
reproducible.

`populate()` writes the workspace and skill files through
`connection.writeFiles()` in one batch. With `mountedAt`, the provider has
mounted `resourcesDirectory()` read-only at that sandbox path, and `populate()`
copies `<mountedAt>/workspace/.` into the workspace root and `<mountedAt>/skills/.`
into `$HOME/.agents/skills` instead of writing them, as Docker does today.
Either way, authored `prepare` runs next, with a logging session over the same
connection.

`resolveProjectPath` stays on both contexts because just-bash's `filesystem`
callback and a host provider need project paths. `host.loadOptionalPackage`
leaves the public context. just-bash calls eve's internal optional-package
loaders directly, an allowed internal engine helper: the installing loader in
`prepare` and the import-only loader in `start` and `resume`, as the two host
implementations do today. It passes `ctx.resolveProjectPath(".")` as the app
root.

`prepare` becomes a standard environment option through `WithPrepareOption`,
typed with the provider's extensions (#3717). A provider without environment
options still accepts `{ prepare }`. eve removes `prepare` before calling the
provider's `environment()`, which always receives an object (`{}` when the
caller passes none), and runs it inside `populate()`. No built-in
includes `prepare` in its template identity today. `sourceRevision` hashes only
the sandbox definition's source file, so it captures a `prepare` written there
but not one imported from another module (see open questions).

### Export inventory

| Module                  | Export                                                                                                                                                                          | Change                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `eve/sandbox/provider`  | `defineSandboxProvider`, `SandboxProviderDefinition`, `SandboxProviderImplementation`                                                                                           | New shape                                                               |
| `eve/sandbox/provider`  | `SandboxProvider`, `SandboxProviderFiles`, `SandboxDeleteOptions`                                                                                                               | Unchanged                                                               |
| `eve/sandbox/provider`  | `SandboxPreparedArtifact`, `SandboxProviderSessionContext`, `SandboxProviderPrepareContext`                                                                                     | Renamed `SandboxJson`, `SandboxSessionContext`, `SandboxPrepareContext` |
| `eve/sandbox/provider`  | `SandboxConnection`, `SandboxIdentity`, `SandboxPrepareOption`, `WithPrepareOption`, `SandboxSessionGoneError`, `SandboxTemplateNotProvisionedError`, `SANDBOX_AGENT_ENV`       | Added                                                                   |
| `eve/sandbox/provider`  | `SandboxProviderHandle`, `SandboxProviderResources`, `SandboxProviderResourceTree`, `SandboxProviderResourceFile`, `SandboxProviderResourceSource`, `SandboxProviderTargetFile` | Removed                                                                 |
| `eve/sandbox`           | `SandboxSession` and its option, process, and result types; `SandboxNetworkPolicy`                                                                                              | eve-owned declarations; `SandboxSession` gains `writeFiles`             |
| `eve/sandbox`           | `SandboxNetworkRule`, `SandboxNetworkMatch`, `SandboxNetworkMatcher`, `SandboxWriteFilesOptions`, `SandboxRemovePathOptions`                                                    | Added                                                                   |
| `eve/sandbox/vercel`    | `Drive`; `VercelSandboxMount`, `VercelSandboxMounts`, `VercelSandboxMountMode`                                                                                                  | `Drive` removed; mount types become eve-owned structural types          |
| `eve/sandbox/just-bash` | `JustBashEnvironmentOptions`, `JustBashFilesystemContext`                                                                                                                       | `customCommands` and `filesystem` use eve-owned structural types        |

Ensure orchestration, the artifact store, identity hashing, `invokeTool`
wiring, and Docker CLI and Vercel SDK glue stay internal.

## Lifecycle

```text
build (eve build, or first access in eve dev)
  eve ─ prepare(ctx) ─▶ provider: create build instance → connection
                        ctx.populate(connection) ─▶ eve: write the workspace root
                          and $HOME/.agents/skills, then run authored prepare
                        provider: capture image or snapshot → artifact (JSON)
  eve: store artifact in sandbox-prepared-artifacts.json (ships with deployment)

runtime
  first access ─ selector → environment.open(options)
                 → start(ctx, options, artifact) → { connection, state }
                 eve checkpoints { providerName, state, stateProtocolVersion }
  later step   ─ resume(ctx, artifact, state) → connection
                 └─ throws SandboxSessionGoneError → eve clears state, reruns selector
  step ends        → connection.close?() (a turn's step, a "use step" function, or an
                     invokeTool call; the next step resumes through a new connection)
  sandbox.stop()   → connection.stop(), connection.close?()
  sandbox.delete() → connection.close?(), onSessionEnd(ctx, state, { reason: "deleted" }),
                     eve clears state
  process exit     → connection.stop(), connection.close?() on the connections the process
                     still holds: any connection mid-step, and each session's latest
                     connection without close() (failures logged, not thrown); a provider
                     with close() and remote compute bounds idle compute itself
  terminal outcome → connection.close?() for a connection the ending step holds,
                     onSessionEnd(ctx, state | null, { reason })
  (close runs at most once per connection; stop is idempotent and may run again after
  the connection resumes; a failed close never blocks deletion)
```

## Invariants

- **Upsert.** `start()` returns the same sandbox for one `ctx.session.id` while
  that sandbox exists and is usable, across repeated, concurrent,
  cross-process, and cross-deployment calls. Native identity comes from
  `ctx.session.id` and a provider-level namespace only, never from open options
  or the artifact.
- **No recreation on resume.** `resume()` never recreates native state. A
  missing sandbox throws `SandboxSessionGoneError`; other failures surface
  unchanged.
- **Cleanup.** `onSessionEnd()` succeeds when nothing exists, tolerates `null`
  state, and is idempotent. `sandbox.delete()` goes through it with
  `reason: "deleted"`, so a provider has one deletion path.
- **Keyed tool sessions.** A keyed `invokeTool` call always starts with
  `state: null` and does not own the sandbox. eve runs the selector and
  `start()` on every call and never calls `onSessionEnd()`. The one `resume()`
  is for a call that overlaps another call's start in the same process: it
  resumes from that start's state. Because nothing ever ends a keyed sandbox, a
  provider that sets `toolSessions: true` must bound retention itself, as Vercel
  does with snapshot expiration. Without `toolSessions`, a keyed call fails with
  `ToolSessionSandboxUnsupportedError` when it requests a sandbox; a keyed
  call that never calls `ctx.getSandbox()` runs normally. An unkeyed call uses a fresh
  `call_session_` id with `kind: "session"`, and calls `onSessionEnd()` when it
  ends if it requested a sandbox.
- **Missing templates.** A provider throws `SandboxTemplateNotProvisionedError`
  when the artifact references an image, snapshot, or template that no longer
  exists. eve throws it too when a deployment has no artifact for the sandbox.
  eve surfaces it to the caller without retrying or rebuilding in production.
  Template retention and pruning stay with the provider.
- **Seeding.** `populate()` writes workspace and skill files before authored
  `prepare`, and runs only at build time. Runtime never seeds.
- **Paths.** Relative paths and working directories resolve from the
  connection's workspace root; eve resolves `$HOME` in skill targets.
  `session.resolvePath(".")` returns the root, which is how the file tools,
  attachment staging, and GitHub checkouts find it. This changes one behavior: Vercel
  passes a relative `workingDirectory` to the SDK unchanged today, while Docker
  and just-bash already resolve it from `/workspace`. The Vercel migration PR
  states this in its changeset.
- **Environment.** Providers apply `SANDBOX_AGENT_ENV` (`AI_AGENT=eve`) beneath
  environment-level `env` when they create the sandbox, as Docker and Vercel do
  today. Per-call `env` overrides both. just-bash has no environment-level
  `env`, so its connection merges `SANDBOX_AGENT_ENV` beneath per-call `env`.
- **Network policy.** A provider that accepts a `SandboxNetworkPolicy`, at open
  or through `setNetworkPolicy`, rejects any part it cannot enforce instead of
  weakening it. Docker accepts only `"allow-all"` and `"deny-all"` and throws
  on allow-lists, subnets, and credential brokering (`docker-network.ts`).
- **Serialization.** eve rejects artifacts and state that are not
  JSON-compatible, and state whose `stateProtocolVersion` differs from the
  provider's. Providers validate the shape of their own state in `resume()`.
  The contract has no validator hooks.

## Byte-identical built-ins

Each built-in keeps its own native-name derivation from `ctx.session.id` and
passes exactly its current identity fields to `ctx.templateKey()`. Each
migration PR adds a golden test that the old and new template keys and session
names match.

| Provider       | Session name (unchanged)                                                 | Template identity passed to `templateKey`                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker         | `eve-sbx-` + hash of `{ namespace: storagePath, sessionId, version: 2 }` | `{ dockerfile: dockerfile?.contentHash, optionsHash, version: 2 }`, first 24 hex                                                                                                            |
| Vercel Sandbox | `eve-sbx-vercel-` + hash of `{ sessionId, version: 2 }`                  | `{ createOptions: vercelIdentityOptions(createOptions), resolvedImage, version: 3 }`, where `resolvedImage` is `undefined` when `source` is set; first 32 hex, `eve-sbx-tpl-vercel-` prefix |
| just-bash      | root directory from hash of `{ sessionId, version: 2 }`                  | `{ autoInstall, customCommands, filesystem, version: 2 }`, first 24 hex                                                                                                                     |

Docker mounts `await ctx.resourcesDirectory()` and calls
`ctx.populate(connection, { mountedAt: "/eve/resources" })`. Vercel skips
preparation when `ctx.isEmpty` and no `source` is set, in
`VercelSandbox.environment()` itself and therefore under `DefaultSandbox` too.
Vercel and just-bash set `toolSessions: true`; no built-in needs `close()`.

## Custom provider example

A backend for a hypothetical snapshot-capable engine, `@acme/sdk`:

```ts
import { createHash } from "node:crypto";
import { defineSandbox } from "eve/sandbox";
import {
  defineSandboxProvider,
  SANDBOX_AGENT_ENV,
  SandboxSessionGoneError,
  type SandboxConnection,
} from "eve/sandbox/provider";
import { AcmeClient, type AcmeMachine } from "@acme/sdk";

export const AcmeSandbox = defineSandboxProvider({
  name: "acme",
  environment(options: { readonly project: string }) {
    const acme = new AcmeClient({ project: options.project });
    // Session ids can be long, so hash them into a bounded machine name.
    const nameFor = (sessionId: string) =>
      `eve-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
    return {
      async prepare(ctx) {
        const key = ctx.templateKey({ project: options.project, version: 1 });
        const template = `eve-tpl-${key.slice(0, 32)}`;
        const cached = await acme.snapshots.find(template);
        if (cached !== null) return { snapshotId: cached.id };
        const machine = await acme.machines.create({
          env: SANDBOX_AGENT_ENV,
          image: "ubuntu:24.04",
        });
        try {
          await ctx.populate(connect(machine));
          return { snapshotId: (await machine.snapshot({ name: template })).id };
        } finally {
          await machine.destroy();
        }
      },
      async start(ctx, open: { readonly egress?: "allow-all" | "deny-all" } | undefined, artifact) {
        const name = nameFor(ctx.session.id);
        // Atomic create-if-absent: an existing machine is returned unchanged,
        // so `egress` and the snapshot apply only on creation.
        const machine = await acme.machines.createIfAbsent({
          egress: open?.egress ?? "allow-all",
          env: SANDBOX_AGENT_ENV,
          name,
          snapshotId: artifact.snapshotId,
        });
        return { connection: connect(machine), state: { name, version: 1 as const } };
      },
      async resume(_ctx, _artifact, state) {
        const machine = await acme.machines.get(state.name);
        if (machine === null)
          throw new SandboxSessionGoneError(`Acme machine "${state.name}" is gone.`);
        return connect(machine);
      },
      async onSessionEnd(ctx, state, { abortSignal }) {
        await acme.machines.destroyIfExists(state?.name ?? nameFor(ctx.session.id), {
          signal: abortSignal,
        });
      },
    };
  },
});

function connect(machine: AcmeMachine): SandboxConnection {
  return {
    spawn: ({ abortSignal, command, env, workingDirectory }) =>
      machine.exec({
        argv: ["bash", "-lc", command],
        cwd: workingDirectory,
        env,
        signal: abortSignal,
      }),
    // Acme returns `null` for a missing path and rejects for a directory.
    readFile: ({ abortSignal, path }) => machine.files.read(path, { signal: abortSignal }),
    writeFiles: ({ abortSignal, files }) =>
      machine.files.write(files, { mkdirs: true, signal: abortSignal }),
    removePath: ({ abortSignal, force, path, recursive }) =>
      machine.files.remove(path, { force, recursive, signal: abortSignal }),
    stop: () => machine.suspend(),
  };
}

export const environment = AcmeSandbox.environment({
  project: "agents",
  prepare: async (sandbox) => {
    await sandbox.run({ command: "apt-get install -y ripgrep" });
  },
});

export default defineSandbox(() => environment.open({ egress: "deny-all" }));
```

## Migration

The public shape changes once, in the first implementation PR. Until each
built-in migrates, core keeps running today's `SandboxProviderImplementation`
as an internal type. An internal adapter compiles the new public shape to it,
so `ensureSandboxAccess`, prewarm, and the artifact store stay unchanged until
the last step. There are no public dual-shape overloads.

1. Switch the public `defineSandboxProvider()` to the new shape, export
   `SandboxSessionGoneError`, `SandboxTemplateNotProvisionedError`, and
   `SANDBOX_AGENT_ENV`, and add `ctx.kind`. In the same PR, update the
   custom-provider docs in `docs/sandbox/index.mdx`, migrate the e2e
   `custom-provider` fixture, and add evals for gone-sandbox recovery and for
   keyed calls on a provider without `toolSessions`. Built-ins keep the old
   shape through the internal type (minor changeset). Implemented: the public
   `writeFiles()` replaced `SANDBOX_WRITE_FILES` in this step, and unit tests
   through the public API cover keyed calls, because no e2e fixture has a
   custom root sandbox behind a keyed channel.
2. Migrate just-bash, with the golden key and name test.
3. Migrate Docker, with the golden key and name test.
4. Migrate Vercel Sandbox, with the golden key and name test. Its changeset
   notes that a relative `workingDirectory` now resolves from `/workspace`.
   Implemented: `VercelSandbox.environment()` itself keeps skipping an empty
   preparation without a `source`, because deployed self-modification relies
   on it, and the same step removed `Drive` (minor changeset).
5. Make core consume the new shape directly. Remove the internal old shape,
   and the tool-session `WeakMap`. Close a connection when the step that
   opened it lets go of it; until then, eve closes connections only at the
   other lifecycle points above. Add a
   `guard:invariants` rule for files under `src/execution/sandbox/bindings/`
   and `src/sandbox/providers/`: they may import the provider contract only
   through `#public/sandbox/*`, and may not import core sandbox modules
   (`#execution/sandbox/{ensure,prewarm,session,logging-session}.js`,
   `#execution/tool-session/*`, `#runtime/sandbox/*`, or
   `#shared/sandbox-{provider,session,write-files}.js`). Engine helpers such
   as other binding modules, stream utilities, and the optional-package loader
   stay allowed. Implemented: `ensureSandboxAccess` runs the implementation and
   its connections directly, `createConnectionSession()` in
   `execution/sandbox/session.ts` derives every session, and `prewarm.ts`
   builds the prepare context. A workflow step, a turn's step, and a keyed or
   unkeyed `invokeTool` call close their connection when they end; after a
   turn's step, a connection without `close()` stays registered for server
   shutdown. `DefaultSandbox` is a `defineSandboxProvider()` selector over the
   three built-ins and keeps its two internal hooks: session end receives the
   prepared artifact, and records the picked provider wrote still resume. The
   guard is rule 44. The opaque provider runtime on `SandboxEnvironment` bumped
   six extension contract epochs, all retained.
6. Workspace-root paths. Implemented: `SandboxConnection.workspaceRoot`
   declares the root, defaulting to `/workspace`; eve rejects a relative one
   when it opens the connection. The built-in file tools accept paths
   relative to the root, `glob` and `grep` search it by default, and
   model-facing prompts no longer name `/workspace`, because they are
   composed before any sandbox opens. The skill root stays
   `$HOME/.agents/skills`, falling back to `skills/` under the workspace root.
7. Later: a host provider on the same contract.

## Open questions

- **Host provider network policy.** A host provider cannot enforce any
  `SandboxNetworkPolicy` except `"allow-all"`. Under the network-policy
  invariant it rejects everything else; decide whether it should also omit
  `setNetworkPolicy`.
- **Extension types through wrappers.** Abort binding, logging, and the runtime
  lifecycle proxy must keep extension members and their types. #5020 needs a
  type test that covers each wrapper.
- **Imported `prepare` callbacks.** `sourceRevision` misses changes to a
  `prepare` imported from another module, so a template can stay stale. Now
  that eve owns `prepare`, it could hash the bundled callback's module graph
  into the template key. That changes every key once, so it belongs in its own
  PR.

## Relationship to other plans

This proposal supersedes three parts of
[`sandbox-environments-open.md`](./sandbox-environments-open.md) (draft):

- **Provider contract and handle hooks.** Connections and `onSessionEnd` replace
  `SandboxProviderHandle`.
- **`prepare` ownership.** That plan said core never reserves `prepare`. This
  one makes it a standard option so eve can seed before `prepare`, compute
  `isEmpty`, and type the `prepare` sandbox with provider extensions.
- **Native identity.** That plan derived native identity from the session id,
  artifact, environment options, and open options, with no core-computed keys.
  Since #5132, native identity comes from the session id and a provider
  namespace only, and this proposal adds the core-computed `templateKey`.

Its environment `open()` model, immutable session state, and gone semantics
still apply.
