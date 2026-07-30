---
issue: https://github.com/vercel/eve/issues/100
status: proposed
last_updated: "2026-07-30"
---

# eve-buzz-acp-adapter package

## Purpose

Package the proven local Buzz reply-sink proxy so a user can run an eve application as a visible Buzz participant without exposing Buzz credentials to the eve runtime or adding Buzz behavior to `eve acp`.

## User experience

Install and register the connector:

```sh
npm install --global eve-buzz-acp-adapter
eve-buzz-acp-adapter install
```

In a TTY, the installer follows eve's existing CLI prompt conventions. It asks whether the target is a local directory or deployed URL, validates the selection, discovers the authored model, shows the resolved configuration, and confirms before writing a Buzz custom-harness definition with absolute executable paths. A positional target accepts either form; headless use requires explicit `--local` or `--url` and `--yes` flags.

The user then selects **eve** in Buzz and uses the harness defaults. Running the harness requires no separate `eve acp` process:

```text
buzz-acp -> eve-buzz-acp-adapter -> eve acp -> eve HTTP runtime
                  |
                  +-> local buzz CLI -> signed, threaded reply
```

Direct execution supports the same target modes as eve:

```sh
eve-buzz-acp-adapter                         # local eve application
eve-buzz-acp-adapter https://agent.example.com
```

## Boundaries

`eve-buzz-acp-adapter` is a separate published package under `packages/`; Buzz-specific behavior remains outside the `eve` package and its generic ACP adapter. The connector:

- proxies ACP stdio to `eve acp`;
- accumulates final assistant text and publishes it with the host-local `buzz` CLI;
- keeps Buzz identity and relay credentials out of the child eve process;
- uses the channel and reply anchor selected by `buzz-acp`;
- reports publication failures as failed ACP turns.

The first package is an experimental compatibility connector pinned to the current Buzz prompt framing. It supports ordinary conversational replies, not arbitrary Buzz actions or remote MCP.

## Packaging

The npm package is named `eve-buzz-acp-adapter` and exposes one binary with runtime, `install`, `uninstall`, and `doctor` commands. It depends on the published `eve` package so the compatible `eve acp` implementation is available without a second installation step. The installer writes only non-secret target metadata to the Buzz harness file. Protected Vercel targets reuse eve's verified-origin login and Trusted Sources flow; runtime requests use short-lived project-scoped OIDC tokens from the local Vercel session. A Protection Bypass for Automation token may be supplied through `VERCEL_AUTOMATION_BYPASS_SECRET` for non-interactive environments.

For current Buzz releases, the connector advertises the eve application's authored model as one fixed ACP model so the standard custom-harness UI can save the configuration. The desired Buzz contract is an explicit agent-managed model policy that does not imply model switching.

## Reliability and security

Before stable release, the connector must:

- parse captured channel, thread, DM, and batched prompt fixtures from a pinned Buzz release;
- validate channel UUIDs and 64-character reply event IDs;
- invoke executables without a shell and pass reply content over stdin;
- remove Buzz private keys, auth tags, and API tokens from the `eve acp` environment;
- forward cancellation and preserve ACP errors;
- bound line size, subprocess output, and publication duration;
- persist a shared idempotency record keyed by the channel and supplied reply anchor before acknowledging publication;
- coordinate idempotency across Buzz's parallel ACP process pool, with a bounded stale-publication lease;
- reject unsupported interactive elicitation and client-local MCP clearly;
- avoid logging credentials or full signed events.

## Upstream path

The preferred end state remains a Buzz-owned final-text reply sink with structured routing metadata. Buzz should also let custom harnesses declare an agent-managed model. Once those capabilities exist, ordinary Buzz use can launch generic `eve acp` directly and this compatibility connector can be deprecated.

## Verification

- Unit tests cover prompt routing, instruction injection, fixed-model projection, publication arguments, and secret filtering.
- Integration tests run the proxy against fake `eve acp` and `buzz` executables, including publication failure and cancellation.
- Captured Buzz fixtures cover top-level, threaded, DM, and malformed prompts.
- A manual Buzz Desktop smoke test verifies installation, harness selection, restart, one correctly threaded reply, and no Buzz credentials in the eve child.
