---
issue: https://github.com/vercel/eve/pull/59
last_updated: "2026-06-27"
status: in_progress
---

# On-demand sandbox egress authorization

## Summary

Vercel Sandbox egress rules may declare `auth`. With `credentialResolution: "eager"` eve resolves
every credential before the sandbox is handed to the step. With `"on-request"` the route stays
unauthenticated until a sandbox request first hits it.

Earlier iterations killed the running command when demand appeared, resolved the credential, and
replayed the command from the beginning. That is unsound for arbitrary shell commands: everything
before the blocked request executes twice (`vercel deploy && gh release create` re-deploys when the
second call demands auth), and no runtime can make arbitrary bash idempotent. Holding the blocked
request open until authorization completes is equally unworkable because interactive authorization
can park a session for hours or days.

The design therefore never replays and never suspends the request. The agent model is the retry
policy, exactly as it already is for connection tools.

## Semantics

1. A request to an unresolved on-request route reaches the egress proxy via a `forwardURL` rule.
   The proxy authenticates the request (Vercel Sandbox OIDC metadata: team, project, sandbox
   session), records demand, and answers HTTP 428 with an explanatory body telling the caller that
   authorization was requested and to re-run once it is granted.

   Demand is proxy-attested: each policy build embeds a host-minted random token in the
   `forwardURL`, and the proxy writes that token as the demand marker's content. The token travels
   only host → firewall → proxy — the sandbox sees the marker file but never a valid token — so eve
   honors a marker only when its content matches the token of the policy build that produced it
   (persisted in captured sandbox metadata across parks). Fabricated and stale markers fail
   verification; deleting a marker is self-denial and fail-closed. Note the boundary this does and
   does not move: any sandbox process can always summon an authorization prompt by genuinely
   requesting the protected domain — exactly as any process can invoke a connection tool — so the
   prompt UX must name the domain and requesting sandbox; the token guarantees a prompt is only
   ever caused by a real, OIDC-authenticated request that traversed the firewall.

2. The blocked request has completed (with an error), so the command exits on its own. eve performs
   one demand check after exit — no polling while the command runs.
3. Demanded credentials that resolve non-interactively are activated immediately: eve updates the
   sandbox network policy and clears the demand record. The command's real output and exit status
   stand; the 428 body tells the model what happened and what to do.
4. Credentials that require sign-in raise the standard authorization interrupt through the tool
   boundary. The step parks; demand records survive the park so the resumed step's sandbox
   attachment activates the approved credential before the model re-runs anything.
5. Side effects that ran before the blocked request happened exactly once, and the model can see
   they happened because output is never retracted. The model re-runs only what it needs to.

Failed attempts are ordinary command failures. There is no replay counter, no output buffering or
rollback, and no process kill/restart machinery.

## Consent scope

Consent is scoped to the sandbox session. Approving a rule grants that sandbox session access to
the route for the lifetime of the underlying authorization: the grant is stored per
`(sandbox session key, rule)`, so later steps resolve it non-interactively — the same model as
connections, where one approval covers every subsequent tool call. Activation is sandbox-wide by
construction (the firewall policy is the enforcement primitive), so a subagent sharing its
parent's sandbox shares its authorized egress; credential isolation inside a shared sandbox would
be theater, since the sandbox already shares filesystem, processes, and env.

Step-end revocation (`revokeStepCredentials` on commit/rollback) is exposure hygiene, not a
consent boundary: it guarantees no credential stays active in the policy once no step is
supervising the sandbox. Concurrent steps sharing one sandbox may revoke under each other;
because every step ends with an idempotent clear and a clear can only remove access, races fail
closed and the policy is always cleared once the last sharing step settles. The cost is
availability only — a sibling command can lose the route mid-flight, fails, and self-heals
through the ordinary fail → retry loop. Reference counting was rejected: parent and subagent
steps run in different workflows with no shared durable home for a counter, and a leaked count
pins credentials open, inverting the failure mode to the dangerous side.

## Remaining work before merge

- **Proxy failures are application responses.** Credential lookup, OIDC acquisition, and sandbox
  lookup can return 403/500 instead of 428; the body must stay precise enough for the model to
  recover. The public `authProxyBaseUrl` contract (deployment rollovers, sandbox-name reuse) needs
  explicit guarantees.
- **End-to-end coverage.** An eval that crosses a real interactive-authorization park/resume, plus
  real-sandbox coverage of proxy authentication, policy updates, and demand settlement.

## Rejected alternatives

- **Kill-and-replay** — double-executes side effects; a replay limit bounds damage without making
  it correct.
- **Suspending the blocked request until authorization completes** — interactive authorization can
  take days; no connection or sandbox lifetime survives that.
- **Host broker proxying authenticated requests upstream** (credentials never enter the sandbox
  policy; request-scoped consent) — attractive long-term, but a large correctness surface
  (streaming, timeouts, TLS semantics) and still fail-fast for interactive auth. Out of scope.
