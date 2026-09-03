---
issue: TBD
status: proposed
last_updated: "2026-08-31"
---

# Vercel Connect build manifest

## Decision

eve will conditionally emit a versioned Vercel Connect manifest when an agent uses
Connect-backed credentials. The manifest declares the integrations the deployment
requires, including enough provider configuration for Connect to create or reconcile
native connectors. It contains no secrets and does not authorize side effects.

The steady-state model identifies a requirement by a project-local logical reference
derived from its authored filesystem path, such as `"channels/slack"`. An explicit
reference override supports definitions that use multiple connectors or intentionally
share one binding. eve is opaque to Connect connector IDs and UIDs. Connect owns the
mapping from the reference to a connector, installation, credentials, and trigger
destinations:

```text
eve reference "channels/slack"
        |
        v
team + project + environment binding
        |
        v
Connect connector
  |- provider application
  |- installation(s)
  |- credentials and grants
  `- binding-owned trigger destination(s)
```

Several projects may bind their local `"channels/slack"` reference to the same
connector. Display names remain mutable Connect metadata and are not used for
resolution.

## Authoring API

Connector requirements stay beside the capability that uses them. eve-owned channels
contribute the minimum capabilities required by their defaults, while the Connect
helper contributes explicit additions:

```ts
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials({
    capabilities: {
      publicChannelMessages: true,
      privateChannelMessages: true,
      additionalBotScopes: ["reactions:read"],
      additionalEvents: ["reaction_added"],
    },
  }),
});
```

The no-reference object form resolves the project/environment binding derived from the
authored path, here `"channels/slack"`. An explicit override handles multiple
connectors in one definition or intentional binding reuse:

```ts
connectSlackCredentials({ reference: "shared/slack" });
```

Both forms are intentionally distinct from the existing string form, which retains its
current meaning as a direct Connect locator:

```ts
// Existing behavior: use this exact connector UID or ID.
connectSlackCredentials("slack/my-agent");
```

Connect and its API requests must preserve direct and binding targets structurally
rather than inferring them from string syntax. Runtime token selection remains
separate from static provisioning requirements:

```ts
connectSlackCredentials({
  capabilities: { publicChannelMessages: true },
  token: { installationId: process.env.SLACK_INSTALLATION_ID },
});
```

Only static, serializable capabilities enter the build manifest. A separate authored
Connect configuration file is not part of the initial API. Project-wide sharing and
environment policy belongs to Connect and Vercel rather than beside channel behavior.

## Manifest contract

Connect owns the connector type vocabulary, provider-specific requirement schemas,
expansion rules, validation, and merge semantics. The manifest's `connector.type`
discriminator uses Connect's `ConnexClientType` values, such as `"slack"`, `"oauth"`,
and `"api-key"`; MCP and OpenAPI remain eve resource protocols rather than connector
types. Connect owns the versioned requirement configuration for each type. That
configuration may project the safe, declarative subset of the type's create and update
inputs rather than exposing secret-bearing input schemas directly. eve does not define
a parallel connector taxonomy. eve evaluates authored definitions,
combines helper metadata with eve-owned defaults and route information, and emits the
expanded requirements.

A representative artifact is:

```json
{
  "kind": "vercel-connect-manifest",
  "schemaVersion": 1,
  "generator": {
    "name": "eve",
    "version": "0.42.0"
  },
  "requirements": [
    {
      "target": {
        "mode": "binding",
        "reference": "channels/slack"
      },
      "connector": {
        "type": "slack",
        "configuration": {
          "agentExperience": true,
          "botScopes": [
            "app_mentions:read",
            "assistant:write",
            "channels:history",
            "chat:write",
            "groups:history",
            "reactions:read"
          ],
          "events": ["app_mention", "message.channels", "message.groups", "reaction_added"]
        }
      },
      "access": {
        "principalTypes": ["app"]
      },
      "triggers": [
        {
          "method": "POST",
          "path": "/eve/v1/slack"
        }
      ],
      "uses": [
        {
          "kind": "channel",
          "name": "slack",
          "logicalPath": "channels/slack.ts"
        }
      ]
    },
    {
      "target": {
        "mode": "binding",
        "reference": "connections/linear"
      },
      "connector": {
        "type": "oauth",
        "configuration": {
          "service": "mcp.linear.app"
        }
      },
      "resource": {
        "protocol": "mcp",
        "url": "https://mcp.linear.app/mcp"
      },
      "access": {
        "principalTypes": ["user"]
      },
      "uses": [
        {
          "kind": "connection",
          "name": "linear",
          "logicalPath": "connections/linear.ts"
        }
      ]
    }
  ]
}
```

Provider service identity and runtime resource URLs are distinct. For example,
`mcp.linear.app` identifies the Connect service while
`https://mcp.linear.app/mcp` is the MCP endpoint.

The artifact is emitted only when at least one compiled definition declares a Connect
requirement. Installing or importing `@vercel/connect` without using a helper does not
emit it. A successful build that removes the final requirement also removes the prior
artifact; a failed build leaves the prior successful output untouched.

## Staged delivery and migration

The manifest can ship before project-local references. The first stage preserves the
semantics of current `@vercel/connect` calls and records their explicit connector
locator:

```ts
connectSlackCredentials("slack/my-agent");
```

```json
{
  "target": {
    "mode": "direct",
    "locator": "slack/my-agent"
  },
  "connector": {
    "type": "slack"
  }
}
```

This stage still enables capability validation, drift reporting, trigger setup, and
reconciliation of the exact connector named in code. It does not solve source
portability: copied projects retain the same locator, separate connectors still need
distinct UIDs in source, and an opaque connector ID cannot serve as a create-if-missing
declaration. A named UID may support creation when Connect defines that behavior, but
UID collisions and ownership remain Connect concerns.

The second stage adds path-derived bindings by default:

```ts
// agent/channels/slack.ts derives "channels/slack".
connectSlackCredentials({});
```

An explicit override remains available for multiple connectors in one definition or
intentional sharing:

```ts
connectSlackCredentials({ reference: "shared/slack" });
```

The default manifest target is unambiguous:

```json
{
  "target": {
    "mode": "binding",
    "reference": "channels/slack"
  },
  "connector": {
    "type": "slack"
  }
}
```

Existing string arguments continue to resolve the exact connector. They are never
silently reinterpreted as references, and Connect never guesses from whether a string
looks like a UID or an `scl_...` ID. This discriminated target shape should exist in
the first manifest schema even if the first implementation accepts only `"direct"`,
so adding `"binding"` does not change existing wire semantics.

Migrating an existing project is a coordinated operation:

1. Connect verifies the direct connector and creates the project/environment binding derived from the authored path.
2. The setup UI or `eve` migration flow removes the direct locator from the source.
3. Subsequent builds declare only the path-derived binding target.

The binding must exist before code relies on it. Missing bindings do not implicitly
fall back to global connector lookup. If the source edit and binding creation cannot be
coordinated, a future explicit migration hint may identify the prior direct locator;
it must be temporary and must not become permanent fallback behavior.

Stage one is therefore independently useful but does not deliver the proposal's full
portable-template or per-environment naming benefits. New scaffolds should omit direct
locators only after Connect can resolve path-derived bindings and the setup UI can
create them.

## Requirement and capability semantics

Logical references are scoped by:

```text
team + project + environment + reference
```

Preview, Production, Development, and custom environments may therefore bind the same
reference differently. Connect may infer likely parent-environment matches but does
not treat equal names as authorization to share resources.

Declared capabilities are additive minimums rather than exact desired state. Connect
reports drift in both directions:

- missing capabilities may break declared functionality;
- excess capabilities mean the selected connector is less restricted than required.

The setup UI makes both differences explicit and asks the user to accept the selected
tradeoff. Connect adds missing capabilities only through an authorized reconciliation
flow and does not automatically remove excess provider permissions. This preserves
shared connectors and makes deployment rollback safe.

When several bindings share one connector, Connect retains requirement provenance and
uses provider-specific merge rules. A merged result may be compatible, require a
permission expansion, require another installation, exceed trigger fan-out limits, or
be incompatible and require a separate connector. eve does not implement those rules.

## Deployment lifecycle and late binding

Connector requirements do not block or trigger deployments. Vercel completes the
deployment, ingests its immutable manifest snapshot, and compares those requirements
with the project/environment bindings and actual connector state. Missing or stale
configuration appears on the deployment and project dashboards without making the
build or deployment fail.

Completing setup does not require another deployment. Connect creates or updates the
binding and the next runtime invocation resolves it immediately:

```text
build -> deploy succeeds -> manifest ingested -> requirements evaluated
                                            |
                         ready -------------+------------- action required
                           |                                  |
                           v                                  v
                     runtime works                  dashboard setup
                                                              |
                                                              v
                                                    late binding is active
```

When outbound runtime work reaches an unresolved requirement, Connect and eve expose a
typed `binding_required` state containing the logical reference and an operator setup
URL. This is distinct from `authorization_required`:

- `binding_required` means the project/environment integration is missing or
  incompatible and an operator must configure it;
- `authorization_required` means the binding is ready but the current user must grant
  access.

Inbound channels cannot rely on runtime recovery. If a Slack application is not
installed or its trigger destination is absent, no request reaches eve to report
`binding_required`. Deployment and project readiness surfaces must therefore remain the
primary recovery path for inbound integrations.

Manifest changes are also non-blocking:

- adding a connector creates an unmet requirement until an operator creates or binds
  it;
- adding scopes, events, commands, shortcuts, or triggers reports configuration drift
  and the least disruptive reconciliation action;
- removing a connector marks its binding stale or excess without deleting shared
  resources.

Connect stores deployment requirements separately from mutable bindings and actual
connector state. This separation lets late binding and later connector changes satisfy
an already-running deployment.

### Rollouts and rollback

During a rolling release, more than one deployment may receive traffic. The effective
environment requirement is the union of the additive minimum capabilities declared by
all traffic-eligible deployments. Connect retains deployment provenance so the UI can
attribute each capability and explain which rollout requires a change.

An instant rollback changes the set of active requirements but does not shrink provider
permissions or delete connector resources. A pending capability increase from the
rolled-back deployment may remain visible in that deployment's history, but it is no
longer an unmet requirement of the active Production deployment. Promoting that version
again causes Connect to reevaluate and resurface its drift. If the first implementation
cannot observe every traffic-eligible deployment, it may use the environment's active
deployment only, but must document that rolling-rollout readiness is approximate.

## Reconciliation and setup

Build artifacts are declarations of intent, not authority. In the first version,
ingestion validates the manifest and computes a setup plan without creating
applications, sharing secrets, changing provider permissions, installing applications,
or attaching trigger destinations. Every reconciliation plan requires explicit human
approval, including plans whose compatible connector choices are preselected.

For each requirement, Connect may propose:

- binding a compatible existing connector and installation;
- creating a connector and provider application;
- creating a new installation;
- collecting an API key or other raw credential;
- expanding provider scopes or event subscriptions;
- attaching the binding's eve trigger destination.

The primary setup UI presents all requirements together. Compatible existing
connectors are preselected when confidence is high, so the normal path is review plus
one approval rather than a separate flow for every requirement. A new project does not
auto-bind merely because Connect found a likely match.

Preview setup must make isolation and sharing explicit. It offers a preview-specific
connector or reuse of an existing connector, and highlights permission expansion,
credential sharing, installations, and event fan-out. In the first version, the likely
parent connector may be preselected but still requires approval.

Requirement readiness is decomposed rather than represented by one boolean:

```text
connector          ready | action_required | conflict
binding            ready | action_required
configuration      ready | action_required | drift
installation       ready | action_required
triggers           ready | action_required | unsupported
runtime user grant on_demand
```

Per-user OAuth consent occurs at runtime and does not block deployment integration
readiness. App installations, shared credentials, and trigger destinations do.

When a requirement disappears, Connect marks its binding state stale but does not
automatically delete a shared connector, uninstall a provider application, revoke
credentials, or remove provider capabilities. Binding-owned deployment destinations
may be cleaned up according to explicit environment policy. An approved reconciliation
becomes effective through late binding and does not redeploy the project.

### Future automatic reconciliation

After the approval-based lifecycle is established, Connect may automatically reconcile
changes covered by previously granted authority and project policy. Examples include an
unchanged binding, a trigger URL update for that binding, or Preview inheritance the
project has explicitly enabled. New credential sharing, ambiguous connector selection,
provider installation, permission expansion, and changes that affect Production remain
approval boundaries unless a later policy explicitly authorizes them. This automation
is future work and does not weaken the first version's approval requirement.

## Ownership boundaries

### `@vercel/connect`

- Defines the framework-neutral manifest and provider requirement schemas.
- Attaches structurally readable metadata to `connect()`, channel credential helpers,
  and raw credential helpers.
- Expands semantic options into provider scopes, events, and capabilities.
- Validates and merges requirements and reports compatibility or drift.

### eve

- Evaluates authored definitions and discovers actual helper usage.
- Combines Connect metadata with channel defaults, source attribution, protocols, and
  route paths.
- Aggregates requirements across the compiled agent graph.
- Conditionally stages, publishes, and removes the artifact atomically.
- Never resolves logical references to connector IDs.

### Vercel and Connect control plane

- Ingests and retains the private manifest snapshot for each deployment.
- Computes active environment requirements from traffic-eligible deployments.
- Compares requirements with mutable bindings and actual connector state.
- Resolves team, project, and environment bindings under authenticated authority.
- Presents preselected connector and installation choices for approval.
- Creates or updates connectors, collects secrets, performs provider handoffs, and
  owns trigger reconciliation.

## Implementation direction

Use structural metadata as the primary integration contract. Connect helpers return
normal eve runtime credential values carrying an additional serializable requirement
marker. eve-owned channel and connection normalizers preserve that marker in compiled
metadata. Arbitrary third-party adapters need an explicit metadata propagation escape
hatch when they hide credential providers inside closures.

Do not register import-side-effect build hooks or let `@vercel/connect` write into
eve's build directories. eve owns concurrent build workspaces and atomic publication.
If several frameworks need a canonical serializer, eve may conditionally load a pure
Connect manifest builder after discovering at least one requirement, while retaining
all filesystem ownership.

The first delivery may support direct targets for native Slack, GitHub, Linear, and
Discord declarations; OAuth MCP and OpenAPI connections; generic API-key requirements;
capability drift; and trigger destinations. A later binding stage adds project-local
references, binding creation, reusable connector selection, and environment-aware
inheritance. Dynamic runtime-selected references remain outside the provisioning
contract.

## Invariants

- The manifest contains requirements and source metadata, never secrets.
- Direct locator and logical binding targets are structurally distinct and never inferred from string shape.
- A logical reference is not a Connect connector ID, UID, or mutable display name.
- Connector readiness never blocks deployment, and satisfying a requirement never requires redeployment.
- Manifest ingestion never grants authority or performs provider mutations by itself.
- The first version requires human approval for every reconciliation plan.
- `binding_required` identifies operator setup and remains distinct from per-user `authorization_required`.
- Rollback changes active requirements without automatically shrinking permissions or deleting resources.
- Capability requirements are additive minimums and drift is visible in both directions.
- Shared connectors retain per-binding capability and trigger provenance.
- Provider configuration and merge semantics remain owned by Connect.
- eve emits no Connect artifact when the compiled agent has no Connect requirements.
