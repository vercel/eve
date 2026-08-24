---
issue: TBD
status: proposed
last_updated: "2026-08-24"
---

# Vercel Connect build manifest

## Decision

eve will conditionally emit a versioned Vercel Connect manifest when an agent uses
Connect-backed credentials. The manifest declares the integrations the deployment
requires, including enough provider configuration for Connect to create or reconcile
native connectors. It contains no secrets and does not authorize side effects.

The steady-state model identifies a requirement by a project-local logical reference
such as `"slack"`. eve is opaque to Connect connector IDs and UIDs. Connect owns the
mapping from the reference to a connector, installation, credentials, and trigger
destinations:

```text
eve reference "slack"
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

Several projects may bind their local `"slack"` reference to the same connector.
Display names remain mutable Connect metadata and are not used for resolution.

## Authoring API

Connector requirements stay beside the capability that uses them. eve-owned channels
contribute the minimum capabilities required by their defaults, while the Connect
helper contributes explicit additions:

```ts
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials({
    reference: "slack",
    capabilities: {
      publicChannelMessages: true,
      privateChannelMessages: true,
      additionalBotScopes: ["reactions:read"],
      additionalEvents: ["reaction_added"],
    },
  }),
});
```

The object form is intentionally distinct from the existing string form. A reference
is a logical name in the project's Connect namespace, while a string retains its
current meaning as a direct Connect locator:

```ts
// Existing behavior: use this exact connector UID or ID.
connectSlackCredentials("slack/my-agent");

// New behavior: resolve the project/environment binding named "slack".
connectSlackCredentials({ reference: "slack" });
```

Connect and its API requests must preserve this distinction structurally rather than
inferring it from string syntax. Runtime token selection remains separate from static
provisioning requirements:

```ts
connectSlackCredentials({
  reference: "slack",
  capabilities: { publicChannelMessages: true },
  token: { installationId: process.env.SLACK_INSTALLATION_ID },
});
```

Only static, serializable capabilities enter the build manifest. A separate authored
Connect configuration file is not part of the initial API. Project-wide sharing and
environment policy belongs to Connect and Vercel rather than beside channel behavior.

## Manifest contract

Connect owns the provider-specific requirement schemas, expansion rules, validation,
and merge semantics. eve evaluates authored definitions, combines helper metadata with
eve-owned defaults and route information, and emits the expanded requirements.

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
        "reference": "slack"
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
        "reference": "linear"
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

The second stage adds the explicit binding form:

```ts
connectSlackCredentials({ reference: "slack" });
```

Its manifest target is unambiguous:

```json
{
  "target": {
    "mode": "binding",
    "reference": "slack"
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

1. Connect verifies the direct connector and creates the project/environment binding.
2. The setup UI or `eve` migration flow changes the source to `{ reference: "slack" }`.
3. Subsequent builds declare only the binding target.

The binding must exist before code relies on it. Missing bindings do not implicitly
fall back to global connector lookup. If the source edit and binding creation cannot be
coordinated, a future explicit migration hint may identify the prior direct locator;
it must be temporary and must not become permanent fallback behavior.

Stage one is therefore independently useful but does not deliver the proposal's full
portable-template or per-environment naming benefits. New scaffolds should switch to
references only after Connect can resolve bindings and the setup UI can create them.

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

## Reconciliation and setup

Build artifacts are declarations of intent, not authority. Ingestion validates the
manifest and computes a setup plan without creating applications, sharing secrets,
changing provider permissions, installing applications, or attaching trigger
destinations.

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
credential sharing, installations, and event fan-out. Automatic parent binding is
allowed only under a previously approved project policy; without that standing policy,
the likely parent connector is preselected but still requires approval. Sensitive
changes require approval even when inheritance is enabled.

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
may be cleaned up according to explicit environment policy.

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

- Ingests the private deployment artifact and computes a reconciliation plan.
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
- Manifest ingestion never grants authority or performs provider mutations by itself.
- Connector reuse is explicit or covered by a previously approved environment policy.
- Capability requirements are additive minimums and drift is visible in both directions.
- Shared connectors retain per-binding capability and trigger provenance.
- Provider configuration and merge semantics remain owned by Connect.
- eve emits no Connect artifact when the compiled agent has no Connect requirements.
