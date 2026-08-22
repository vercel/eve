---
issue: https://github.com/vercel/eve/pull/59
last_updated: "2026-06-26"
status: blocked
---

# On-demand sandbox egress authorization

## Summary

This branch prototypes resolving a Vercel Sandbox egress credential only after a sandbox request
reaches an authenticated network-policy rule. The current design is not merge-ready. Eager
credential brokering can be reviewed independently; on-demand resolution needs a protocol that does
not trust sandbox-writable state and does not replay an arbitrary shell command.

The prototype installs a `forwardURL` rule for an unresolved credential. The proxy validates the
Vercel Sandbox OIDC metadata, writes `/tmp/eve-egress-demand/<ruleId>` into the originating sandbox,
and returns HTTP 428. While an awaited command runs, eve polls those marker files every 50 ms. When
it finds one, it kills the command, resolves the credential, replaces the sandbox-wide network
policy, and starts the command again from the beginning.

Some useful safeguards are already present: unresolved routes fail closed, the proxy checks team,
project, and sandbox session identity, rule ids are validated, replay is bounded, and managed
credentials are removed when the step scope is disposed. Those safeguards do not address the
failure modes below.

## Blocking failure modes

### The sandbox is being trusted to report its own demand

The marker directory is writable by the workload whose network access is being mediated. Any
sandbox process can create a valid, predictable marker without making the corresponding blocked
request. The proxy's OIDC validation authenticates a request when it writes a marker, but that proof
is lost when eve later treats the presence of a plain file as authorization demand.

Consequences include:

- untrusted code can trigger an interactive authorization prompt without making a genuine request;
- a stale or forged marker is indistinguishable from a proxy-created marker;
- marker contents do not bind the demand to a request, command, attempt, principal, or expiration;
- checking and deleting the marker is a time-of-check/time-of-use protocol over attacker-controlled
  state.

Demand must be recorded in host-owned state, or carried as a verifiable single-use capability bound
to the sandbox session, rule, request/attempt identity, and expiry. A signing secret placed inside
the sandbox would not establish this boundary.

### Credential activation is sandbox-wide

After one command demands a rule, the prototype updates the network policy for the entire sandbox.
Every concurrent process in that sandbox can then use the authenticated route until step disposal;
the credential is not scoped to the request or command that triggered consent. An on-demand prompt
therefore does not imply on-demand use or least privilege.

A viable design must define the authorization scope explicitly. If consent is request-scoped, the
original request needs to continue through a host-controlled broker. If policy activation remains
sandbox-wide, the API and security model must say so and concurrent processes must be treated as
equally authorized.

### Replaying a shell command is not generally safe

The proxy does not suspend and continue the blocked HTTP request. Eve kills `bash -lc <command>` and
runs the complete command again. Everything before the blocked request may execute twice:

- filesystem writes and local database mutations;
- subprocess creation and writes to local services;
- unauthenticated or differently authenticated network calls;
- external side effects that completed before the blocked request;
- reads of clocks, randomness, mutable files, and remote state that change the replayed control
  flow.

Killing the top-level command also does not, by itself, prove that every descendant has stopped
before replay starts. A command may catch termination, leave detached work behind, or race a side
effect with marker detection. The replay is a new execution, not a continuation of the original
request, so even an apparently idempotent command can issue a different request after consent.

The three-replay limit bounds damage but does not make replay correct. It can also reject legitimate
commands that discover more than three authenticated routes sequentially.

### Concurrent commands share unowned markers and credentials

Markers are keyed only by rule id and shared by the sandbox. They carry no command id or attempt id.
With multiple awaited commands:

- command A can observe command B's marker and restart unnecessarily;
- one command can clear demand before another observes it;
- concurrent credential resolutions can duplicate prompts or apply sandbox policy updates out of
  order;
- a marker left by a crashed or cancelled command can restart a later command;
- one command can activate a credential for another command during the policy-update window.

The protocol needs per-request ownership, atomic claiming, deduplication, and explicit behavior for
simultaneous requests for the same or different rules.

## Correctness and operational failure modes

### Polling is expensive and incomplete

An awaited process reads one file per on-demand rule every 50 ms. Work therefore grows with both
command duration and rule count, generating continuous Sandbox API traffic and adding up to a poll
interval of detection latency. Detached and otherwise un-awaited processes are not observed at all.

Polling also creates lifecycle races: demand can arrive during process exit, cancellation, host
failure, or sandbox suspension. The post-exit check narrows one race but does not provide durable
delivery or exactly-once consumption.

### Output cannot be rolled back

The adapter delays and buffers only the most recent 64 KiB/100 ms of stdout and stderr. Earlier
output is already visible and cannot be retracted when the attempt is discarded. Users can receive
duplicated or contradictory output from failed attempts, while the most useful tail diagnostics may
be hidden. Buffering all output would increase memory and latency but still would not roll back
side effects.

The custom stream adapter also has to reproduce process semantics for completion, cancellation,
errors, and backpressure. That is a large correctness surface for a credential feature.

### Proxy and host failures are observable as application responses

The sandbox program receives HTTP 428 only after the proxy successfully locates the sandbox and
writes the marker. Credential lookup, OIDC acquisition, sandbox lookup, and marker writes can
instead return 403 or 500. The program can handle any of these as ordinary HTTP responses, exit
successfully, retry independently, or take another side effect before eve notices demand.

The design also requires a stable public HTTPS `authProxyBaseUrl`. Preview/production origin
selection, deployment rollovers, sandbox-name reuse, and proxy availability become part of the
credential protocol and need explicit guarantees.

### Authorization suspension is not proven durable end to end

Interactive authorization can interrupt credential resolution after the original process has been
killed. The active command, stream controllers, replay counter, marker state, and credential map are
in-memory objects. Unit tests mock the command and marker APIs; they do not prove behavior across a
real workflow suspension, worker restart, resumed sandbox, callback, or cancelled authorization.

Unavailable credentials also clear the marker and fail the awaited process after its original
attempt has been killed. This is fail-closed, but the error and retry contract exposed to the agent
and user is not yet designed.

## Required design decisions

Before implementation continues, decide:

1. Whether consent authorizes one HTTP request, one command, one sandbox step, or the whole sandbox.
2. Whether the original request can be paused and resumed by a trusted broker without restarting
   user code.
3. Where durable demand state lives and how requests are authenticated, uniquely identified,
   expired, claimed, and deduplicated.
4. What concurrent commands and simultaneous demands are allowed to observe.
5. How cancellation, host restart, sandbox resume, proxy outage, and authorization rejection settle
   a pending request.
6. What stdout/stderr and exit status mean when authorization is required.

## Merge-readiness bar

On-demand resolution should remain outside the main credential-brokering PR until the design:

- removes sandbox-writable files as the source of truth for demand;
- avoids arbitrary command replay, or exposes a narrowly defined retryable operation with explicit
  idempotency requirements;
- scopes credential use consistently with the consent shown to the user;
- handles concurrent requests atomically and durably;
- has bounded overhead without per-rule 50 ms polling;
- specifies cancellation, failure, and output semantics;
- includes real Vercel Sandbox coverage for proxy authentication, policy updates, and cleanup;
- includes an end-to-end interactive authorization eval that crosses the callback suspension;
- tests forged and stale demand, concurrent commands, side effects before demand, multiple rules,
  process trees, cancellation, proxy failure, host restart, and sandbox resume.

Until those conditions hold, the safe product behavior is eager credential resolution before the
sandbox is returned, with unresolved routes left closed.
