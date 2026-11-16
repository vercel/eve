---
title: Sanity Blueprints
description: Rules for Sanity Blueprints, the Infrastructure as Code solution for managing Sanity resources declaratively. Covers blueprint files, stacks and scope, the plan/deploy workflow, deletion policies, error recovery, and CI deployment.
---

# Sanity Blueprints

Sanity's Infrastructure as Code (IaC) solution. Define resources declaratively in `sanity.blueprint.ts`, track the file in version control, preview changes with `plan`, apply them with `deploy`. Blueprints is the only way to deploy Sanity Functions.

The CLI is built for unattended use: every command accepts `--json`, all IDs can be supplied via flags or environment variables, and `--help` on any command is the authoritative reference. Always run via `npx sanity@latest blueprints <command>`.

## Mental Model

```
Blueprint file (code, intent) → Stack (deployed state) → Resources (real infrastructure)
```

| Concept | What it is |
|---------|------------|
| **Blueprint file** | `sanity.blueprint.ts`, the declarative manifest of desired resources. The source of truth: if it's not in the file, it's not deployed |
| **Resource** | One managed thing (function, CORS origin, webhook, role, robot token, dataset). Identified by a unique `name` |
| **Definer** | Typed helper from `@sanity/blueprints` (e.g. `defineCorsOrigin`) that declares a resource and validates input as you write |
| **Stack** | The deployed counterpart of the file: the live resources on Sanity's side. One file can deploy to many Stacks (e.g. `staging`, `production`) |
| **Config file** | `.sanity/blueprint.config.json`, links the local file to a Stack and records scope. Gitignored by `init` automatically; not secret |
| **Scope** | `project` or `organization`. Determines which resource types a Stack can manage |

### Key behaviors

- Resources are matched **by `name`** between file and Stack. `plan` buckets every resource as create, update, no-op, or destroy.
- **There is no rename.** Changing a resource's `name` destroys the old resource and creates a new one under the new name.
- **Removal is destruction.** Deleting a resource from the file destroys it on the next deploy (subject to its deletion policy). `blueprints destroy` is equivalent to deploying an empty file.
- Deploys apply in dependency order. On partial failure, completed changes are rolled back best-effort in reverse order. Rollback is **not atomic**; some actions may be irreversible.

## Three different "deploy" commands

Do not confuse these:

| Command | What it deploys |
|---------|-----------------|
| `sanity blueprints deploy` | Infrastructure resources defined in `sanity.blueprint.ts` |
| `sanity schema deploy` | Studio schema to Content Lake (for MCP and editor access) |
| `sanity deploy` | The Studio application to Sanity hosting |

## The Blueprint File

`sanity.blueprint.ts` default-exports a `defineBlueprint` call. TypeScript is idiomatic (definers validate inline and provide editor help); `.js` and hand-written `.json` also work but new files should use TypeScript.

```typescript
import {defineBlueprint, defineCorsOrigin, defineDocumentFunction} from '@sanity/blueprints'

export default defineBlueprint({
  values: {
    corsOrigin: 'https://studio.example.com',
  },
  resources: [
    defineCorsOrigin({
      name: 'studio-cors',
      origin: '$.values.corsOrigin',
    }),
    defineDocumentFunction({
      name: 'first-published',
      event: {
        on: ['create', 'update'],
        filter: "_type == 'post' && !defined(firstPublished)",
      },
    }),
  ],
})
```

- `resources` is an array of definer outputs. Every resource requires a unique `name`.
- `values` holds reusable file-level constants (always strings), referenced as `$.values.<key>`.
- Resource-type-specific fields are documented in the typed reference: https://reference.sanity.io/_sanity/blueprints/

### Discovering available resources

The definers exported by `@sanity/blueprints` are the canonical list of what Blueprints can manage. Discover them by inspecting the package's exports (every `define*` function is a resource definer) and reading their TSDoc for fields, defaults, and examples, or browse the typed reference at https://reference.sanity.io/_sanity/blueprints/. Do not rely on a memorized list; new definers ship additively.

When the Stack is organization-scoped, project-contained resources (CORS origins, webhooks, datasets, functions) must set their `project` field explicitly.

For the semantics of an individual resource type (what a CORS origin, webhook, or role does and which values make sense), consult that feature's own Sanity documentation. This reference covers how Blueprints manages resources, not the resources themselves.

## References and the Resource Graph

Resources reference values and each other with `$` string paths:

| Syntax | Resolves | When |
|--------|----------|------|
| `$.values.<key>` | A constant from the `values` block | At file evaluation |
| `$.resources.<name>` | Another resource in the file | At deploy time; creates a dependency edge |
| `$.resources.<name>.id` | The generated ID of that resource, as a string | At deploy time |

Blueprints builds the dependency graph from these references and orders work so dependencies are created first. Unresolved references and cycles fail validation before anything is deployed. To force ordering without a data reference, use `lifecycle: {dependsOn: '$.resources.<name>'}`.

### Referencing an existing project

The recommended pattern is an environment variable surfaced through `values`:

```typescript
import 'dotenv/config' // the CLI does not read .env files itself

export default defineBlueprint({
  values: {
    projectId: process.env.SANITY_PROJECT_ID ?? '',
  },
  resources: [
    defineCorsOrigin({
      name: 'app-cors',
      project: '$.values.projectId',
      origin: 'https://www.example.com',
    }),
  ],
})
```

## Deletion Policies

Set `lifecycle.deletionPolicy` on a resource to control what removal means:

| Policy | Removed from file | Stack destroyed | Notes |
|--------|-------------------|-----------------|-------|
| `allow` | Resource destroyed | Resource destroyed | Default for stateless resources |
| `retain` | **Deployment fails** | Resource detached, kept alive | Default for stateful resources like datasets |
| `replace` | Resource destroyed | Resource destroyed | Updates become destroy + recreate |
| `protect` | **Deployment fails** | **Deployment fails** | Resource is never updated or destroyed |

Use `protect` for production-critical stateful resources:

```typescript
defineDataset({
  name: 'production',
  lifecycle: {deletionPolicy: 'protect'},
})
```

A deletion-policy violation is a pre-deploy validation failure, not a partial deploy: fix the file (or consciously change the policy) and re-run `plan`.

## Stacks, Environments, and Scope

One blueprint file deploys to many Stacks. The `--stack <name-or-id>` flag (on `deploy`, `plan`, `info`, `logs`) selects the target; without it, the Stack recorded in `.sanity/blueprint.config.json` is used.

- **Only `init` creates Stacks.** `--stack` never creates a Stack on a miss, so CI cannot accidentally provision infrastructure. Re-run `blueprints init .` to add another Stack for the same file.
- Accounts are currently limited to **three Stacks per project scope**.
- For per-environment differences, read an environment variable inside the file (e.g. `process.env.SANITY_ENV`) and deploy with the env var and `--stack` together. `SANITY_ENV` is a convention your file reads, not a CLI feature.

### Project vs organization scope

| | Project scope | Organization scope |
|---|--------------|--------------------|
| Stored in config as | `projectId` | `organizationId` |
| Resources default to | The project | Nothing; each project-contained resource must name its `project` |
| Org-scoped resource types | Not available | Available |

Organization scope is recommended for anything beyond a single-project experiment. Convert an existing Stack with `blueprints promote` (safe, idempotent, additive, but **one-way**; requires `organization-update` admin permission).

## CLI Commands

```bash
npx sanity@latest blueprints <command>
```

| Command | Purpose |
|---------|---------|
| `init [dir]` | Create a blueprint file and provision a remote Stack. The only command that creates Stacks |
| `plan` | Preview the diff against the Stack. Read-only, always safe |
| `deploy` | Apply the file to the Stack (`-m` message, `--no-wait` to queue and return) |
| `info` | Show Stack status and deployed resources. Remote read; works without local files |
| `stacks` | List Stacks (`--include-projects` with `--organization-id` for org-wide audit) |
| `config` | View or edit `.sanity/blueprint.config.json` (`--edit` with ID flags for scripting) |
| `logs` | Deployment logs (`--watch`, `--limit 1-500`, `--since`/`--before` ISO timestamps) |
| `promote` | Convert a Stack from project to organization scope. One-way (`--force` to skip confirmation) |
| `destroy` | Destroy the Stack and its resources (`--force` to skip confirmation). Local files remain |
| `doctor` | Diagnose local/remote configuration issues (`--fix` to resolve interactively) |
| `mint-deploy-token` | Mint a long-lived robot token for CI deploys (`--print` for shell pipelines) |

Running `npx sanity@latest blueprints --help` will show the latest available commands.  
Use `npx sanity@latest blueprints <command> --help` to see options and examples for a specific command.

Function scaffolding, local testing, secrets, and function logs live under `npx sanity@latest functions <command>` (`add`, `dev`, `test`, `env add|list|remove`, `logs`). See the `functions` reference.

### Standard workflow

```bash
npx sanity@latest blueprints init .   # once: create file + Stack
# edit sanity.blueprint.ts
npx sanity@latest blueprints plan     # preview the diff, catch validation errors safely
npx sanity@latest blueprints deploy   # apply
npx sanity@latest blueprints info     # verify deployed state
```

Always run `plan` before `deploy`. It is read-only and surfaces validation errors, reference problems, scope mismatches, and deletion-policy violations without touching anything.

### Exit codes

`deploy` and `destroy` return: **`0`** succeeded, **`2`** failed, **`75`** accepted but completion could not be confirmed.

**✅ Correct — treat exit 75 as unknown, then verify:**
```bash
npx sanity@latest blueprints deploy || status=$?
if [ "${status:-0}" -eq 75 ]; then
  npx sanity@latest blueprints info --json   # confirm actual Stack state
fi
```

**❌ Incorrect — treating any nonzero exit as failure and retrying.** Exit 75 means the deployment was accepted; blindly redeploying can queue duplicate operations (deploy also refuses to start while another operation is in progress).

### Scope resolution and environment variables

For `organizationId`, `projectId`, and `stackId`, the first source that resolves wins: CLI flags → environment variables → the blueprint file module → the local config file.

| Variable | Purpose |
|----------|---------|
| `SANITY_AUTH_TOKEN` | Auth token (in CI, the minted deploy token) |
| `SANITY_ORGANIZATION_ID` / `SANITY_PROJECT_ID` | Scope |
| `SANITY_BLUEPRINT_STACK_ID` | Target Stack |
| `SANITY_BLUEPRINT_PATH` | Path to the blueprint file or its directory |
| `SANITY_ASSET_TIMEOUT` | Seconds to wait for resource asset processing (default 60) |

The CLI does not load `.env` files. Export variables in the shell or import `dotenv/config` inside the blueprint file.

## Errors and Recovery

Errors include a name, a human-readable message, and the **resource path**, which maps to a specific resource in your file. Five failure kinds:

| Failure | Caught | What to do |
|---------|--------|------------|
| Validation error (missing/invalid field, malformed file) | Before deploy | Fix the file at the reported resource path |
| Unresolved reference or dependency cycle | Before deploy | Fix the `$.resources.<name>` reference or break the cycle |
| Scope mismatch (org-scoped resource on project Stack, or no resolvable `project`) | Before deploy | Set the resource's `project` field, or `promote` the Stack |
| Deletion-policy violation (change would remove a `retain`/`protect` resource) | Before deploy | Restore the resource, or deliberately relax its policy |
| Execution failure (underlying service rejected the change) | During deploy | Read `blueprints logs`, fix the cause, redeploy |

Recovery procedure after any failure:

1. Read the error message and resource path (`blueprints logs` re-reads failure output).
2. Fix the blueprint file (or the external condition).
3. Run `blueprints plan` to confirm the corrected diff.
4. Run `blueprints deploy` again.

Retrying without changing anything only makes sense for transient execution failures; the first four failure kinds are deterministic and will fail identically until the file changes. If local and remote state seem inconsistent, run `blueprints doctor` (and `doctor --fix`) before attempting anything destructive. After a partial-deploy rollback, `blueprints info` shows what is actually live; resources owned by other Stacks are never touched by rollback.

## CI/CD

Recommended workflow: `plan` on pull requests, `deploy` on merge to main. Official GitHub Actions: https://github.com/sanity-io/blueprints-actions

```bash
# one-time, by a human with access:
npx sanity@latest blueprints mint-deploy-token --label "ci-deploy" --print
```

The minted robot token has exactly the role needed to plan, deploy, and destroy (`blueprints-deployer` for project scope, `blueprints-deployer-robot` for organization scope) and is revocable under Robots in Sanity Manage. Store it as a CI secret, then in the pipeline:

```bash
export SANITY_AUTH_TOKEN=<the minted token>
export SANITY_ORGANIZATION_ID=<orgId>        # or SANITY_PROJECT_ID
export SANITY_BLUEPRINT_STACK_ID=<stackId>
npx sanity@latest blueprints deploy --json --message "CI deploy"
```

**✅ Correct — secrets via server-side function env vars:**
```bash
npx sanity@latest functions env add my-function API_KEY sk-...
```

**❌ Incorrect — secrets in the blueprint file's `env` block, which is committed to git:**
```typescript
defineDocumentFunction({
  name: 'my-function',
  env: {API_KEY: 'sk-...'},  // committed to version control!
})
```
