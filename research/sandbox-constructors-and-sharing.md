---
issue: TBD
status: draft
last_updated: "2026-09-11"
---

# Sandbox constructors and sharing

## Default sandbox

The default sandbox keeps its observable behavior: provider selection, template
prewarm, workspace and skill seeding, one persistent sandbox per eve session,
and restoration. Its implementation moves onto the same environment and
constructor protocol as authored sandboxes:

```ts
const environment = DefaultSandbox.environment();

export default defineSandbox(() => environment.create());
```

`DefaultSandbox.environment()` selects the current Vercel, Docker, microsandbox,
or just-bash implementation. It uses the existing imperative snapshot/template
preparation path, not the experimental Dockerfile path.

The object form is removed. There is no compatibility adapter or migration
layer; sandbox definitions use only the callback-return shape.

The default and authored sandboxes therefore share one runtime model. Omitting a
sandbox file still requires no author configuration.

## Proposed model

An opted-in sandbox module returns the sandbox its agent should use:

```ts
export default defineSandbox((ctx) => Sandbox | Promise<Sandbox>);
```

Provider constructors expose the parameters and preparation methods they
support. There is no generic `key`, `scope`, or `use()` abstraction.

- `create(params)` creates a sandbox owned by the current eve session.
- `getOrCreate({ name, ...params })` intentionally shares a named sandbox.
- `eve build` prepares exported provider-owned environment assets.
- The definition callback performs runtime setup before returning the sandbox.

An exported environment is an immutable, build-prepared base plus constructors
for named persistent sandboxes:

```ts
interface SandboxEnvironment<CreateOptions> {
  readonly provider: string;
  create(options?: CreateOptions): Promise<RuntimeSandboxSession>;
  getOrCreate(options: CreateOptions & { name: string }): Promise<RuntimeSandboxSession>;
}
```

For the Dockerfile-backed Vercel environment, the built value contains exactly
the inputs needed by `Sandbox.getOrCreate`:

```ts
type ExperimentalVercelDockerfileArtifact = {
  image: string;
  skills: DriveSnapshot;
  workspace: DriveSnapshot;
};
```

The environment does not own mutable sandbox state. eve computes its revision
from the authored source, provider options, prepared resources, and Dockerfile
when present. Provider build artifacts remain opaque behind the provider
contract rather than becoming author-visible environment fields.

The snapshot-backed Vercel environment uses a different immutable base:

```ts
type VercelSnapshotArtifact = {
  snapshotId: string;
};
```

`eve build` discovers the exported environment and produces its artifact. The
environment consumes that artifact when `create()` or `getOrCreate()` runs.
`defineSandbox` only requires the callback to return an eve-owned `Sandbox`, so
it does not need to understand snapshots, images, or Drives.

## Custom providers with `defineSandboxProvider`

Built-in and third-party providers use the same `defineSandboxProvider()` contract. The contract is the only boundary between sandbox orchestration and provider-specific code: eve owns names, environment generations, preparation locks, resource descriptors, persisted metadata, and shared-configuration validation; the provider owns its native image or snapshot preparation, named lookup or creation, reconnection, and lifecycle operations.

A custom provider defines its immutable environment options, per-sandbox create options, and persisted provider metadata:

```ts
import { defineSandboxProvider } from "eve/sandbox/provider";

export const AcmeSandbox = defineSandboxProvider<
  { image: string; region: string },
  { networkPolicy?: "allow-all" | "deny-all" },
  { remoteId: string }
>({
  name: "acme",

  environment(options) {
    const driver = createAcmeDriver(options);

    async function resourceMounts(resources) {
      const mounts = {};
      for (const resource of [resources.workspace, resources.skills]) {
        if (!resource) continue;
        const volume = resource.path
          ? await driver.volumes.uploadDirectory({ key: resource.key, path: resource.path })
          : await driver.volumes.get(resource.key);
        mounts[resource.mountPath] = { volume, readOnly: true };
      }
      return mounts;
    }

    return {
      async prepare(ctx) {
        const temporary = await driver.createTemporary({
          mounts: await resourceMounts(ctx.resources),
          name: ctx.templateName,
        });
        const sandbox = adaptAcmeSandbox(temporary);
        await sandbox.run({
          command: [
            "cp -a /eve/resources/workspace/. /workspace/ 2>/dev/null || true",
            'mkdir -p "$HOME/.agents"',
            'ln -s /eve/resources/skills "$HOME/.agents/skills" 2>/dev/null || true',
          ].join("\\n"),
        });
        await ctx.runPreparation(sandbox);
        await driver.saveTemplate(ctx.templateName, temporary);
        return { reused: false };
      },

      async getOrCreate(ctx) {
        const remote = await driver.getOrCreate({
          existingId: ctx.existing?.remoteId,
          mounts: await resourceMounts(ctx.resources),
          name: ctx.sandboxName,
          networkPolicy: ctx.options.networkPolicy,
          template: ctx.templateName,
        });

        return ctx.handle({
          sandbox: adaptAcmeSandbox(remote),
          metadata: { remoteId: remote.id },
          stop: () => remote.stop(),
          shutdown: () => remote.stop(),
          delete: () => remote.delete(),
        });
      },
    };
  },
});
```

Agent authors then use the custom provider exactly like a built-in provider:

```ts
import { defineSandbox } from "eve/sandbox";
import { AcmeSandbox } from "../lib/acme-sandbox";

export const environment = AcmeSandbox.environment({
  image: "acme/node@sha256:...",
  region: "iad1",
  prepare: async (sandbox) => {
    await sandbox.run({ command: "install-agent-dependencies" });
  },
});

export default defineSandbox(({ session }) =>
  environment.create({
    networkPolicy: policyFor(session),
  }),
);
```

`environment({ prepare })` is the only preparation shape. There are no separate provider `prepare()` constructors and no provider-specific bootstrap hooks. The provider uploads, mounts, or writes `ctx.resources`, then `ctx.runPreparation(sandbox)` invokes the authored callback before the provider captures its template.

The object returned by `environment.create()` or `environment.getOrCreate()` is the real eve `RuntimeSandboxSession`. The selector may call its filesystem, process, network-policy, and lifecycle methods before returning it. Provider-specific creation fields, such as Vercel resources, network policy, timeout, or Drive mounts, belong to the provider's typed create options.

Vercel, Docker, microsandbox, just-bash, and default selection must themselves be defined through `defineSandboxProvider()`. Built-ins may use provider-specific drivers, but they may not bypass the provider contract to call sandbox orchestration, key derivation, registries, or session state directly.

## One sandbox per eve session

Use `create`. eve invokes the definition when the session first needs its
sandbox, persists the returned sandbox handle, and restores that handle later.

```ts
export const environment = VercelSandbox.environment();

export default defineSandbox(({ session }) => {
  return environment.create({
    networkPolicy: networkPolicyFor(session),
    resources: { vcpus: 4 },
  });
});
```

Two eve sessions call `create` independently:

```text
session s1 → Vercel sandbox A
session s2 → Vercel sandbox B
```

The application does not supply `session.id` as a resource key. eve owns the
association between the returned sandbox and the durable session.

## Sharing across eve sessions

Use `getOrCreate` with an application-defined name:

```ts
export const environment = VercelSandbox.environment();

export default defineSandbox(({ session }) => {
  const teamId = requireTeamId(session);

  return environment.getOrCreate({
    name: `team-${teamId}`,
    networkPolicy: sharedTeamPolicy,
    resources: { vcpus: 4 },
  });
});
```

Sessions that resolve the same name receive handles to the same provider
sandbox:

```text
session s1, team acme ─┐
                       ├→ Vercel sandbox "team-acme"
session s2, team acme ─┘
```

The authored name is the logical shared identity, not the final provider name.
eve namespaces it with the project and sandbox definition, then adds the
current environment revision. Both `create()` and `getOrCreate()` therefore use
the same provider operation; only the logical name source differs:

```text
create()                    → logical name = eve session ID
getOrCreate({ name })       → logical name = authored name
provider name               → definition + environment revision + logical name
```

`create()` needs no authored name. It derives one from the eve session and
calls the provider's named `getOrCreate` operation with the environment's image
or snapshot and mounts:

```ts
await Sandbox.getOrCreate({
  name: providerName(environmentRevision, session.id),
  image: prepared.image,
  mounts: {
    "/eve/resources/skills": prepared.skills,
    "/eve/resources/workspace": prepared.workspace,
  },
  persistent: true,
});
```

The eve session persists the returned handle and restores it on later turns.
`environment.getOrCreate({ name })` performs the same operation with an authored
logical name so independent eve sessions can resolve one shared sandbox.

Changing an environment never creates or resets an eve session. It creates a new
sandbox generation:

```text
session s1 + "team-acme" + environment v1 → sandbox generation v1
session s2 + "team-acme" + environment v1 → sandbox generation v1

new deployment publishes environment v2

existing s1 and s2 → remain pinned to sandbox generation v1
new session s3     → resolves "team-acme" to sandbox generation v2
```

Constructor parameters are part of the generation's configuration. Calls that
resolve the same logical name and environment revision must agree on resources
and security configuration; conflicting calls fail instead of mutating a shared
sandbox underneath another session.

## Runtime setup

The callback-return API has no `use()` or `onSession` shape.
The constructor returns the sandbox directly:

```ts
export const environment = VercelSandbox.environment();

export default defineSandbox(async ({ session }) => {
  const sandbox = await environment.create({
    networkPolicy: initialPolicy(session),
  });

  await sandbox.writeTextFile({
    path: ".eve/session.txt",
    content: session.id,
  });

  return sandbox;
});
```

Authored code opens or creates the sandbox directly. The `create()` call above
is still session-owned even though no name appears: eve persists the returned
handle on that session.

Build-time imperative preparation still receives a temporary sandbox directly:

```ts
export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await sandbox.run({ command: "sudo apt-get install -y jq" });
  },
});
```

## Network policy

Set the initial policy in constructor parameters so untrusted code never runs
before the policy is active:

```ts
return environment.create({
  networkPolicy: {
    allow: {
      "api.github.com": [],
    },
  },
});
```

A dedicated sandbox may change its policy later:

```ts
const sandbox = await environment.create({ networkPolicy: "deny-all" });
await sandbox.setNetworkPolicy(nextPolicy);
return sandbox;
```

A shared sandbox must use one shared policy. Per-session credentials, identity
files, or policy changes are unsafe because another attached session sees the
same filesystem and network boundary. Shared credential brokering needs a
request-aware mechanism outside the sandbox filesystem.

## Current Vercel snapshot model

`VercelSandbox` is the constructor API over today's implementation. Imperative
preparation, workspace, and skills are captured in a Vercel Sandbox snapshot:

```ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await sandbox.run({ command: "sudo apt-get install -y jq" });
  },
});

export default defineSandbox(({ session }) => {
  return environment.create({
    networkPolicy: networkPolicyFor(session),
    resources: { vcpus: 4 },
  });
});
```

`eve build` runs `prepare` in temporary Vercel compute, writes compiled
workspace and skills, and captures a snapshot. `environment.create()` then
creates the same persistent per-eve-session Vercel Sandbox used today. Later
turns restore that sandbox; they do not create a new one.

When no `prepare` callback is needed, `VercelSandbox.environment()` still uses
today's behavior: workspace and skills produce a snapshot-backed template, and
an environment with no template inputs starts from the managed Vercel image:

```ts
export const environment = VercelSandbox.environment();

export default defineSandbox(() => {
  return environment.create({ networkPolicy: "deny-all" });
});
```

The framework default uses this environment internally. Its implementation
remains snapshot-backed when compiled resources exist and persistent per eve
session at runtime.

## Experimental Vercel Dockerfile model

```text
agent/sandbox/
├── Dockerfile
├── sandbox.ts
└── workspace/
```

```ts
import { defineSandbox } from "eve/sandbox";
import { ExperimentalVercelDockerfile } from "eve/sandbox/vercel";

export const environment = ExperimentalVercelDockerfile();

export default defineSandbox(({ session }) => {
  return environment.create({
    networkPolicy: networkPolicyFor(session),
    resources: { vcpus: 4 },
  });
});
```

`eve build` prepares three artifacts:

```text
Dockerfile → digest-pinned VCR image
skills     → read-only Drive snapshot
workspace  → read-only Drive snapshot
```

Runtime uses image plus Drives without exposing mounts to the author. The
read-only workspace snapshot is a seed mount; `/workspace` remains on the
sandbox's private persistent filesystem:

```ts
await Sandbox.create({
  image: built.image,
  persistent: true,
  mounts: {
    "/eve/resources/skills": built.skills.snapshot(),
    "/eve/resources/workspace": built.workspace.snapshot(),
  },
});
```

eve copies the workspace seed into `/workspace` once when it creates the
sandbox. Skills can remain read-only and be exposed at the model-facing skill
path. The Drive snapshots support multiple readers, while each sandbox keeps
private writes in its persistent filesystem.

## Local Docker with a Dockerfile

```ts
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.dockerfile({
  networkPolicy: "deny-all",
});

export default defineSandbox(() => environment.create());
```

`eve build` runs `docker build` and binds the resulting local image to the
exported environment. At runtime, eve mounts content-addressed workspace and skill
volumes read-only:

```text
sandbox image                         → container root filesystem
workspace volume → /eve/resources/workspace:ro
skills volume    → /eve/resources/skills:ro
```

The first container creation copies the workspace seed to writable
`/workspace`. Each created Docker container has its own writable layer. A named `environment.getOrCreate({ name })` reuses the same container and layer
across eve sessions.

An existing image bypasses Dockerfile preparation:

```ts
export const environment = DockerSandbox.image("ghcr.io/acme/agent@sha256:...", {
  networkPolicy: "deny-all",
});

export default defineSandbox(() => environment.create());
```

## microsandbox with a Dockerfile

```ts
import { defineSandbox } from "eve/sandbox";
import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";

export const environment = MicrosandboxSandbox.dockerfile();

export default defineSandbox(() => {
  return environment.create();
});
```

`eve build` builds the OCI image and prepares a microsandbox template. Runtime
mounts the same content-addressed resources read-only:

```text
workspace volume → /eve/resources/workspace:ro
skills volume    → /eve/resources/skills:ro
```

The template copies workspace seeds to `/workspace`; live VMs receive a private
writable COW layer. `environment.getOrCreate({ name })` reuses one named VM and
its writable state across eve sessions.

## Environment-selecting Dockerfile sandbox

The framework-owned default sandbox remains unchanged. Authors who want one
Dockerfile definition to select the hosted or local implementation opt into a
separate experimental constructor:

```ts
import { defineSandbox } from "eve/sandbox";
import { ExperimentalDockerfileSandbox } from "eve/sandbox/dockerfile";

export const environment = ExperimentalDockerfileSandbox();

export default defineSandbox(({ session }) => {
  return environment.create({
    networkPolicy: networkPolicyFor(session),
  });
});
```

It selects `ExperimentalVercelDockerfile` on Vercel, then local Docker or
microsandbox where available. It does not fall back to just-bash because
just-bash cannot consume a Dockerfile. The selected implementation owns image
preparation and read-only volume mounting; the authoring shape stays the same.

## just-bash

just-bash exposes neither images nor Dockerfiles:

```ts
import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

export const environment = JustBashSandbox.environment();

export default defineSandbox(() => {
  return environment.create();
});
```

It may expose imperative preparation for its virtual filesystem:

```ts
export const environment = JustBashSandbox.environment({
  prepare: async (sandbox) => {
    await sandbox.writeTextFile({ path: "config.json", content: "{}" });
  },
});

export default defineSandbox(() => {
  return environment.create();
});
```

`JustBashSandbox.dockerfile()` and `JustBashSandbox.image()` do not exist, so
unsupported sources fail at authoring time.

## Environment revisions and shared sandboxes

The author supplies only the logical name:

```ts
return environment.getOrCreate({
  name: `team-${teamId}`,
});
```

eve automatically combines that name with `environmentRevision`. A Dockerfile,
image, prepared snapshot, static skill, or workspace seed change can produce a
new revision without requiring authored naming logic.

An eve session stores the concrete sandbox handle it received, so it remains
pinned to that generation across turns and deployments. A new eve session uses
the current environment generation. eve retires an old generation only after
no session references it and its retention period expires.

The writable layer is generation-specific and is not automatically rebased onto
a new image or workspace seed. State that must cross generations belongs in an
explicit durable data resource or an authored migration.

## Container image build pipeline

Vercel has two relevant build paths. The interactive CLI wraps an installed
container engine:

```sh
vercel vcr build docker agent/sandbox agent-runtime:<revision> --push
```

Vercel also supports building Dockerfiles during deployments. The proposed eve
integration uses that hosted capability for Vercel builds and a local container
tool for local builds. Both paths produce a VCR image named under the active
project:

```text
vcr.vercel.com/<team-slug>/<project>/<repository>@sha256:<digest>
```

The repository leaf should derive from the sandbox definition identity. The
build tag can use the Dockerfile content revision, but the environment artifact
must store the returned digest-pinned reference rather than the mutable tag.

Image storage and deduplication remain VCR concerns. eve should always build
and push, then keep the digest returned by the builder. It should not implement
image or layer deduplication.

VCR prepares eligible Linux AMD64 images for Sandbox asynchronously. Runtime
passes the digest-pinned reference to `Sandbox.create({ image })` and relies on
Sandbox's documented image-readiness behavior.

The first experimental eve implementation will duplicate only the image-build
portion of the published `@vercel/container` package behind a private eve
adapter. The adapter's contract is limited to building and pushing a Linux AMD64
image and returning its digest-pinned VCR reference. It does not emit or deploy
a container-backed Vercel Function.

```ts
const image = await buildVercelSandboxImage({
  contextDir: sandboxDirectory,
  dockerfilePath: `${sandboxDirectory}/Dockerfile`,
  repository: sandboxRepository,
  tag: environmentRevision,
});
```

The duplicated module should stay private and note its public package source.
The target is to replace it with a shared image-build export once one is
available. Vercel e2e should exercise the eve builder through `eve build` rather
than maintain a separate image path.

`@vercel/sandbox@3.3.0` exposes `Drive.snapshot()` and accepts Drive objects or
snapshot mount descriptors directly. Both eve vendor aliases now resolve to
that stable SDK, so the current snapshot implementation and experimental
image-plus-Drives implementation share one API version.

## Build and runtime binding

Environment assets must be exported because `eve build` cannot invoke a
session-dependent sandbox definition:

```ts
export const environment = ExperimentalVercelDockerfile();

export default defineSandbox(({ session }) => {
  return environment.create({
    networkPolicy: networkPolicyFor(session),
  });
});
```

The compiler discovers the branded export. The build asks its owner to prepare
an opaque artifact and freezes that artifact into deployment output. At runtime,
the same exported value is bound to the built artifact before the default
sandbox definition runs.

```text
compile → discover environment export
eve build → provider builds opaque artifact
runtime → bind artifact → invoke definition → return Sandbox
```

This protocol is expressive enough for both Vercel models because artifact
shape belongs to the environment that produced it.

## API summary

```ts
defineSandbox((ctx) => Sandbox | Promise<Sandbox>);

VercelSandbox.environment().create(params);
VercelSandbox.environment().getOrCreate({ name, ...params });
VercelSandbox.environment({ prepare }).create(params);

ExperimentalVercelDockerfile().create(params);
ExperimentalVercelDockerfile().getOrCreate({ name, ...params });

DockerSandbox.image(reference, { prepare }).create();
DockerSandbox.dockerfile({ prepare }).create();
DockerSandbox.environment({ prepare }).create();

MicrosandboxSandbox.dockerfile({ prepare }).create();
MicrosandboxSandbox.dockerfile().getOrCreate({ name });

ExperimentalDockerfileSandbox().create(params);
ExperimentalDockerfileSandbox().getOrCreate({ name, ...params });

JustBashSandbox.environment().create();
JustBashSandbox.environment({ prepare }).create();
```

Both Vercel environments return the same eve-owned `Sandbox`. The separate
experimental environment keeps the image-plus-Drives lifecycle visible while
`VercelSandbox` preserves snapshot behavior. The framework default uses the
same constructor protocol with its current environment selection.
