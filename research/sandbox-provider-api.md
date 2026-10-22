---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-10-22"
---

# Low-level sandbox provider API

## Summary

Replace the public `defineSandboxProvider()` contract with a smaller one that
custom backends and eve's built-in providers (Vercel Sandbox, Docker,
microsandbox, just-bash, and a later host provider) all use. A backend
implements a byte-level `SandboxConnection` and a lifecycle of `prepare`,
`start`, `resume`, and `onSessionEnd`. eve derives the full `SandboxSession`,
seeds build instances, names templates, and maps stop, delete, and shutdown.

Related: #3502 (third-party provider), #3717 (typed `prepare` sandbox), #4774
(batched writes), #5020 (custom session methods).

## Problem

Verified against `main` at `a2c6d64ed3`:

- **Custom providers write the whole session.** `SandboxProviderHandle.sandbox`
  must implement all ten `SandboxSession` methods (`run`, `spawn`, three reads,
  three writes, `removePath`, `resolvePath`). The builder that derives them from
  primitives, `buildSandboxSession`, is internal (`execution/sandbox/session.ts`).
  The e2e `custom-provider` fixture hand-writes all ten.
- **Three stop-like handle hooks.** `onSandboxStop`, `onRuntimeShutdown`, and
  `onSandboxDelete`. Docker and Vercel map the first two to the same stop call.
- **Recovery and capabilities are private.** `SandboxSessionGoneError`, which
  `ensureSandboxAccess` uses to start a fresh sandbox (#5117), is not exported.
  Keyed `invokeTool` sandboxes require `withToolSessionSandboxes`, a private
  `WeakMap` marker. Batched writes go through the private `SANDBOX_WRITE_FILES`
  symbol. A custom provider can use none of these.
- **Built-ins duplicate the same work.** Each one derives native names from the
  session id, hashes template keys from `sandboxProviderResourceIdentity` and
  `sourceRevision`, hand-validates artifacts and state (`requireDockerSessionState`
  and similar), seeds workspace and skill files and then runs authored `prepare`
  through `createLoggingSandboxSession`, defines `resolvePath`, merges
  `SANDBOX_AGENT_ENV`, and builds the handle trio.
- **Third-party types leak.** `SandboxSession` and its option types are
  `Pick`/`Parameters` of the AI SDK's `Experimental_SandboxSession`.
  `SandboxNetworkPolicy` is an alias of `Vercel.NetworkPolicy`. `eve/sandbox/vercel`
  re-exports `Drive`. `JustBashSandboxCreateOptions` exposes just-bash's
  `CustomCommand` and `IFileSystem`. The provider context exposes
  `host.loadOptionalPackage`, an eve-internal installer.

## Constraints

- **Build-time baking stays.** Vercel snapshots, Docker images, microsandbox VM
  snapshots, and just-bash template directories capture workspace and skill
  files plus authored `prepare` during `eve build` (or first access in
  `eve dev`). Prepared artifacts are JSON in `sandbox-prepared-artifacts.json`
  and ship with the deployment. Snapshot providers cannot seed skills on first
  open.
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
write, and `SandboxNetworkPolicy` types instead of deriving them from `ai` or
`@vercel/sandbox`. A type test asserts that `SandboxSession` stays assignable to
the AI SDK's `Experimental_SandboxSession` method set. `SandboxSession` gains a
public `writeFiles()`; it is not atomic, and a rejected batch may leave earlier
files written (#4774).

### Layer 1: the connection a backend implements

```ts
export interface SandboxConnection<Extensions extends object = {}> {
  /** `workingDirectory` is absolute; `env` is fully merged; the signal is composed. */
  spawn(options: {
    readonly command: string;
    readonly workingDirectory: string;
    readonly env: Readonly<Record<string, string>>;
    readonly abortSignal?: AbortSignal;
  }): Promise<SandboxProcess>;
  /** Returns `null` when the path does not exist. */
  readFile(options: {
    readonly path: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
  /** The only write primitive. Paths are absolute. */
  writeFiles(options: SandboxWriteFilesOptions): Promise<void>;
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  /** Defaults to anchoring relative paths at `/workspace`. */
  resolvePath?(path: string): string;
  /** Releases compute and keeps the sandbox's files. */
  stop(): Promise<void>;
  /** Permanently removes the sandbox. */
  delete(options?: SandboxDeleteOptions): Promise<void>;
  /** Provider capabilities merged onto the session, such as `setNetworkPolicy`. */
  readonly extensions?: Extensions;
}
```

eve derives everything else: `run` over `spawn`, binary and text variants,
encodings and line ranges, single-file writes over `writeFiles`, path and
working-directory resolution, environment layering, abort-signal binding, and
logging during preparation. Every built-in already buffers writes before
sending them, so a bytes-only write primitive does not regress them.

### Layer 2: the provider lifecycle

```ts
export function defineSandboxProvider<
  EnvironmentOptions extends object | undefined,
  OpenOptions extends object | undefined,
  Artifact extends SandboxJson,
  State extends SandboxJson,
  Extensions extends object,
>(definition: {
  readonly name: string;
  readonly stateProtocolVersion?: number;
  environment(
    ...args: SandboxOptionArguments<EnvironmentOptions>
  ): SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions>;
}): SandboxProvider<
  EnvironmentOptions & SandboxPrepareOption<SandboxSession & Extensions>,
  OpenOptions,
  SandboxSession & Extensions
>;

export interface SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions> {
  prepare(ctx: SandboxPrepareContext<Extensions>): Promise<Artifact>;
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
    options: { readonly reason: "completed" | "expired" | "failed" },
  ): Promise<void>;
  /** Present when sandboxes can outlive one keyed `invokeTool` call. */
  readonly toolSessions?: {
    release?(connection: SandboxConnection<Extensions>): Promise<void>;
  };
}

export interface SandboxSessionContext {
  /** Derive native identity from this. The owning session's id, or a keyed tool session's id. */
  readonly key: string;
  readonly kind: "session" | "tool-session";
  /** The calling session. A subagent that shares its parent's sandbox sees its own id here. */
  readonly session: SandboxSelectorContext["session"];
  readonly storagePath: string;
}

export interface SandboxPrepareContext<Extensions extends object> {
  readonly files: SandboxProviderFiles;
  readonly storagePath: string;
  /** No workspace or skill files and no authored `prepare`. */
  readonly isEmpty: boolean;
  log(message: string): void;
  /** SHA-256 hex of `identity` combined with the resource keys and `sourceRevision`. */
  templateKey(identity: SandboxJson): string;
  /** A stable read-only host copy (`workspace/`, `skills/`) for bind mounts, when one exists. */
  resourcesDirectory(): Promise<string | undefined>;
  /** Writes workspace and skill files, then runs authored `prepare` with a logging session. */
  populate(
    connection: SandboxConnection<Extensions>,
    options?: { readonly mountedAt?: string },
  ): Promise<void>;
}
```

Type parameters are inferred from the returned implementation, so authors do
not pass five explicit generics. `SandboxJson` is today's
`SandboxPreparedArtifact` under a name that fits both artifacts and state.

`prepare` becomes a standard environment option:
`SandboxPrepareOption<Session>` adds
`prepare?: (sandbox: Session) => void | Promise<void>`, typed with the
provider's extensions (#3717). eve removes it before calling the provider's
`environment()` and runs it inside `populate()`. No built-in includes `prepare`
in its template identity today, and `sourceRevision` already captures changes
to it.

### Public surface changes

| Change         | Items                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Newly public   | `SandboxConnection`, `SandboxSessionGoneError`, `SandboxTemplateNotProvisionedError`, `ctx.key`, `ctx.kind`, `SandboxSession.writeFiles`                                                                                           |
| Removed        | `SandboxProviderHandle`, `SandboxProviderResources`, `SandboxProviderResourceTree`, `SandboxProviderResourceFile`, `SandboxProviderResourceSource`, `SandboxProviderTargetFile`, `ctx.host`, `ctx.resources`, `ctx.sourceRevision` |
| Stays internal | Ensure orchestration, artifact store, identity hashing, `invokeTool` wiring, Docker CLI and Vercel SDK glue                                                                                                                        |

Built-in providers may import internal engine helpers, such as the Docker CLI
wrapper, but reach core only through the public provider contract.

## Lifecycle

```text
build (eve build, or first access in eve dev)
  eve ─ prepare(ctx) ─▶ provider: create build instance → connection
                        ctx.populate(connection) ─▶ eve: write /workspace and
                          $HOME/.agents/skills, then run authored prepare
                        provider: capture image or snapshot → artifact (JSON)
  eve: store artifact in sandbox-prepared-artifacts.json (ships with deployment)

runtime
  first access ─ selector → environment.open(options)
                 → start(ctx, options, artifact) → { connection, state }
                 eve checkpoints { providerName, state, stateProtocolVersion }
  later step   ─ resume(ctx, artifact, state) → connection
                 └─ throws SandboxSessionGoneError → eve clears state, reruns selector
  sandbox.stop()   → connection.stop()
  sandbox.delete() → connection.delete(), eve clears state
  process exit     → connection.stop() (failures logged, not thrown)
  keyed tool call ends → toolSessions.release?(connection)
  terminal outcome → onSessionEnd(ctx, state | null, { reason })
```

## Invariants

- `start()` returns the same sandbox for one `ctx.key` across repeated,
  concurrent, cross-process, and cross-deployment calls. Native identity comes
  from `ctx.key` and a provider-level namespace only, never from open options or
  the artifact.
- `resume()` never recreates native state. A missing sandbox throws
  `SandboxSessionGoneError`; other failures surface unchanged.
- `onSessionEnd()` succeeds when nothing exists, tolerates `null` state, and is
  idempotent.
- `populate()` writes workspace and skill files before authored `prepare`, and
  runs only at build time. Runtime never seeds.
- Connections see only absolute paths and an absolute working directory.
  Relative paths resolve from `/workspace`; eve resolves `$HOME` in skill targets.
- Environment precedence remains `AI_AGENT=eve` below environment-level `env`,
  which is below per-call `env`.
- eve rejects artifacts and state that are not JSON-compatible.
- Keyed `invokeTool` calls fail with `ToolSessionSandboxUnsupportedError` unless
  the provider declares `toolSessions`.

## Built-in sketches

**Docker.** `prepare` computes
`ctx.templateKey({ dockerfile, optionsHash, version: 2 }).slice(0, 24)`, which
equals today's key. It reuses an existing image for that key. Otherwise it
starts a build container with `await ctx.resourcesDirectory()` mounted at
`/eve/resources`, runs base setup, calls
`ctx.populate(connection, { mountedAt: "/eve/resources" })`, stops, and commits.
It returns `{ imageReference }`. `start` keeps today's name derivation and its
"is already in use" race handling. `resume` throws `SandboxSessionGoneError`
only for "no such container". Extensions: `setNetworkPolicy`.

**Vercel Sandbox.** The template identity is the create options without
credential fields, plus the resolved image and `version: 3`. The snapshot
pointer protocol stays inside the provider. The `DefaultSandbox` facade skips
preparation when `ctx.isEmpty`; `VercelSandbox.environment()` does not. `start`
names the sandbox from `ctx.key` and applies snapshot retention when
`ctx.kind === "tool-session"`. Extensions: `name` and `setNetworkPolicy`.
`toolSessions: {}`, since a connection holds only an SDK client.

**just-bash and microsandbox.** just-bash populates a temporary root and
publishes it by rename. It declares `toolSessions.release` as
`(connection) => connection.stop()`. microsandbox follows Docker and keeps its
own session-identity hash and lifecycle lock.

## Custom provider example

A backend for a hypothetical snapshot-capable engine, `@acme/sdk`:

```ts
import { defineSandbox } from "eve/sandbox";
import {
  defineSandboxProvider,
  SandboxSessionGoneError,
  type SandboxConnection,
} from "eve/sandbox/provider";
import { AcmeClient, type AcmeMachine } from "@acme/sdk";

export const AcmeSandbox = defineSandboxProvider({
  name: "acme",
  environment(options: { readonly project: string }) {
    const acme = new AcmeClient({ project: options.project });
    const nameFor = (key: string) => `eve-${key}`;
    return {
      async prepare(ctx) {
        const template = `eve-tpl-${ctx.templateKey({ version: 1 }).slice(0, 32)}`;
        const cached = await acme.snapshots.find(template);
        if (cached !== null) return { snapshotId: cached.id };
        const machine = await acme.machines.create({ image: "ubuntu:24.04" });
        try {
          await ctx.populate(connect(machine));
          return { snapshotId: (await machine.snapshot({ name: template })).id };
        } finally {
          await machine.destroy();
        }
      },
      async start(ctx, open: { readonly egress?: "allow" | "deny" } | undefined, artifact) {
        const name = nameFor(ctx.key);
        const machine = await acme.machines.upsert({
          egress: open?.egress ?? "allow",
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
      async onSessionEnd(ctx, state) {
        await acme.machines.destroyIfExists(state?.name ?? nameFor(ctx.key));
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
    readFile: ({ path }) => machine.files.read(path),
    writeFiles: ({ abortSignal, files }) => machine.files.write(files, { signal: abortSignal }),
    removePath: ({ force, path, recursive }) => machine.files.remove(path, { force, recursive }),
    stop: () => machine.suspend(),
    delete: () => machine.destroy(),
  };
}

export const environment = AcmeSandbox.environment({
  project: "agents",
  prepare: async (sandbox) => {
    await sandbox.run({ command: "apt-get install -y ripgrep" });
  },
});

export default defineSandbox(() => environment.open({ egress: "deny" }));
```

## Migration

During migration, `defineSandboxProvider()` accepts both shapes. TypeScript
overloads select by return type. An internal adapter compiles the new shape to
today's `SandboxProviderImplementation`, so `ensureSandboxAccess`, prewarm, and
the artifact store stay unchanged until the last step. Each built-in keeps its
native names, state shape, and template key.

1. Add the connection API, the adapter, and the public errors. Migrate the e2e
   `custom-provider` fixture as proof (patch).
2. Migrate just-bash.
3. Migrate Docker.
4. Migrate microsandbox.
5. Migrate Vercel Sandbox.
6. Remove the old shape, `buildSandboxSession`'s export, the tool-session
   `WeakMap`, and `SANDBOX_WRITE_FILES`. Add a `guard:invariants` rule that
   bindings import core only through `eve/sandbox/provider` types. Update
   `docs/sandbox/index.mdx` (minor).
7. Later: a host provider on the same contract.

## Open questions

- **`AI_AGENT` precedence.** Docker and Vercel apply `AI_AGENT` with the
  environment `env` at creation. microsandbox and just-bash merge it for each
  spawn. If eve merges it for each spawn without the environment `env`, a
  per-call `AI_AGENT=eve` overrides an environment-level `AI_AGENT`.
  Options: make `env` a standard environment option that eve layers, or have eve
  pass `{ AI_AGENT: "eve" }` to providers to apply at creation.
- **Relative working directories.** Docker resolves a relative
  `workingDirectory` from `/workspace`, and just-bash `cd`s relative to it.
  Vercel and microsandbox pass it through raw. Central resolution changes their
  behavior for relative values.
- **`readFile` return type.** The union lets each backend return what it has;
  a single type is simpler for implementers to test.
- **Extensions through wrappers.** Abort binding, logging, and the runtime
  lifecycle proxy must keep extension members and their types (#5020).
- **Host provider and network policy.** A host provider cannot enforce
  `SandboxNetworkPolicy`; decide whether it omits `setNetworkPolicy` or rejects
  policies at open.
- **Third-party escape hatches.** Whether to wrap or drop the `Drive` re-export
  and just-bash's `filesystem` and `customCommands` types.
- **Validators.** Optional `artifact` and `state` validators would replace the
  hand-written `require*` functions and give clearer errors on corrupt state.

## Relationship to other plans

[`sandbox-environments-open.md`](./sandbox-environments-open.md) (draft) says
core never reserves fields such as `prepare` in environment options. This
proposal reverses that one rule so eve can order seeding before `prepare`,
compute `isEmpty`, and type the `prepare` sandbox with provider extensions. The
rest of that plan, including provider-owned identity, immutable state, and gone
semantics, still applies.
