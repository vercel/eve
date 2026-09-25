---
issue: TBD
status: proposed
last_updated: "2026-09-24"
---

# Simplify the CLI around local, remote, and project scopes

## Summary

The CLI currently mixes local development, interactions with an existing agent,
and internal setup continuations in adjacent command surfaces. This proposal
makes local and remote work explicit, removes a narrow channel command, hides
registry-owned setup plumbing, and makes inspection commands consistent.

The resulting top-level workflow is:

```text
eve init → eve dev → eve build → eve start/deploy
eve remote <operation> <url>
```

This is intentionally a pre-1.0 breaking cleanup. Do not retain compatibility
aliases for removed command shapes unless a migration proves one necessary.

## Command surface

### Local development and remote agents

`eve dev` starts a local development server only. It no longer accepts a URL
positionally or through `--url`.

Add a `remote` command group for operations against an already-running eve
agent:

```text
eve remote
├─ connect <url>                 Open the interactive terminal client
├─ invoke <url> [prompt]         Send a headless invocation
└─ info <url>                    Verify and inspect the remote agent's public status
```

All remote commands require an explicit URL. A local server may be targeted by
passing its URL explicitly. No remote command starts a local application.

`eve acp [url]` remains outside this group. It is one ACP-over-stdio bridge
with local and remote targets, rather than a general remote-agent operation.
Without a URL it supervises the local agent; with one it bridges to the
existing target.

`remote info` is deliberately narrower than local `eve info`. It verifies that
the target is a reachable eve agent and reports only intentionally public,
runtime-level information, such as compatibility and supported capabilities.
It does not expose source discovery, local diagnostics, or build artifacts.

A future explicit convenience such as `--deployed` may resolve the production
URL for a linked Vercel project. It must print the chosen URL before use and
must never be the implicit behavior when a target is omitted.

### Configuration

Replace flag-only `eve set` with focused setting operations:

```text
eve set model <model> [--reasoning <effort>]
eve set reasoning <effort>
```

The model command supports the common atomic update of model and reasoning.
The reasoning command supports changing reasoning without changing the model.
Both retain the current source editing and validation rules. They replace the
ambiguous flag-only form without introducing a generic configuration namespace.

### Inspection and setup

Normalize local diagnostics around explicit `show` and `list` operations:

```text
eve logs show [logid]
eve logs list
eve traces show [trace]
eve traces list
```

`show` is the default operation for both groups. Use `list`, not `ls`, in the
public surface.

Remove `eve channels` and `eve channels list`. Channel discovery remains
available through `eve info`; a channel namespace can return when it owns a
real management workflow.

Hide `eve integration setup <kind>`. Registry installation and its printed
continuations remain supported, but this trusted-registry setup mechanism is
not a discoverable top-level workflow. `integration connect` remains hidden.

## Scope rules

Command scope must be clear in CLI help and reference documentation:

| Scope                            | Commands                                                |
| -------------------------------- | ------------------------------------------------------- |
| One selected agent               | `dev`, `start`, `info`, `eval`, `logs`, `traces`, `set` |
| Current application or workspace | `build`                                                 |
| Current Vercel project           | `link`, `deploy`                                        |
| Explicit existing target         | `remote` and `acp <url>`                                |

`eve build` continues to build every member when invoked at an agent-workspace
root, and one application otherwise. It does not gain `--agent` merely for
symmetry. Options that apply only to individual applications, including
`--profile`, must be clearly rejected or documented at workspace scope.

## Boundaries

- `eve eval --url` remains an explicit remote evaluation target; it is not an
  interactive remote-agent client and does not move under `remote`.
- `eve acp [url]` remains a single transport-specific command rather than a
  member of the remote-client group.
- `eve add` and `eve registry` retain their current public roles: installation
  is a common top-level action, while catalog configuration and discovery are
  namespaced.
- `eve extension init` and `eve extension build` remain namespaced because an
  extension package is distinct from an agent application.
- This proposal does not define a remote deployment-selection policy or expand
  remote status into a general administration API.

## Validation

Add command parsing and help coverage for the new and removed surfaces. Cover
remote target verification, distinct unreachable/authentication/not-eve-agent
failures, explicit local-URL targeting, and workspace build scope. Update the
CLI reference and remote/ACP documentation alongside the implementation.
