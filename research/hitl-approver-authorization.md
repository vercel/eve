---
issue: "1021"
status: proposed
last_updated: "2026-07-29"
---

# Authorize who may settle a HITL approval

## Goal

Close the authorization gap in [#1021](https://github.com/vercel/eve/issues/1021): a
channel can authenticate the person clicking an approval control, but eve
currently accepts any matching `inputResponse` as the terminal approval.

The proof of concept should make a Slack + GitHub agent usable without an
application-owned identity directory:

```text
Slack responder clicks Allow
  -> eve obtains proof of that responder's GitHub identity through an
     existing authorization challenge
  -> GitHub policy determines whether that identity may allow this action
  -> eligible: settle the original approval and execute as the agent
  -> ineligible: keep the original approval pending and give the responder
     private feedback
  -> any authenticated participant may instead Cancel the proposed action
```

The GitHub write credential remains separate from the approver credential. An
agent GitHub App / installation token (or a self-hosted agent's configured
PAT/app-token provider) performs the write; a responder's user-scoped GitHub
authorization only proves who is approving and supports the eligibility check.

## Non-goals

The PoC must not introduce an eve identity product:

- no canonical-user table, account-link store, or SCIM/IdP integration;
- no generic directory, RBAC, or policy-decision API;
- no inference that a Slack user and GitHub user are the same person from a
  display name or email;
- no Slack-only enforcement embedded in rendered Block Kit controls.

The durable response-authorization boundary should be generic because tools,
connections, channels, `eve/client`, and proxied subagents share it. The
turnkey policy and identity proof are GitHub-specific and belong in
`github-tools`.

## Current state

- A signed Slack interaction already becomes `session.auth.current` for its
  resume turn. `buildSlackAuthContext()` namespaces it by workspace and Slack
  user ID.
- `packages/eve/src/harness/input-requests.ts` treats an `approve` response as
  terminal: it records the approval key, clears the pending input batch, and
  appends the approval response to history.
- Tool and connection OAuth is already durable. `ctx.getToken()` in a tool
  emits `authorization.required`, parks, and retries after callback
  completion. Its order today is **approve, then sign in**, because it runs
  only from tool execution after eve has accepted approval.
- `@github-tools/sdk/eve` maps `requireApproval` into eve's request-time
  `Approval` predicate. It has no response-time authorization support.
- `github-tools` currently uses Connect without a subject parameter, so its
  helper receives Connect's app-scoped installation token and performs GitHub
  operations as the installed app. That is correctly separate from the
  approver identity.
- **Confirmed in the Connex implementation:** the native `github` connector
  supports both `app` and `user` subjects. Its user path redirects to
  GitHub's OAuth authorize endpoint, exchanges the callback code for a GitHub
  user token, and reads `/user`; Connex stores that user-scoped authorization
  against the requested subject and exposes the stable numeric GitHub user ID
  as `externalSubject` (and through token-info userinfo). The app path mints a
  GitHub App installation token.
- This Connect path is available to a Vercel-linked deployment: the SDK uses
  the deployment's Vercel OIDC token to call Connect. `github-tools`' current
  `connectGithubToken()` uses that app/install-token path. On a self-hosted
  eve deployment, the current `github-tools` path is a static token or async
  agent-token provider; it has no built-in per-user GitHub OAuth.
- eve itself already supports self-hosted interactive OAuth through
  `defineInteractiveAuthorization`: the author provides token lookup/storage,
  start URL/PKCE state, and code exchange; eve owns callback URL generation,
  durable park/resume, and challenge delivery. The response-authorizer must
  accept this ordinary eve provider shape rather than require Connect.

## Proposed product shape

Extend eve approval definitions with a response-time authorizer alongside the
existing request-time gate. Naming is intentionally illustrative:

```ts
approval: {
  request: always(),
  async response({ request, response, responder, session, auth }) {
    const identity = await auth.getToken(githubApproverAuth);
    return githubApprover.isEligible({ identity, request, response })
      ? { status: "allowed" }
      : { status: "rejected", safeReason: "You cannot approve this action." };
  },
}
```

Function shorthand remains the request-time-only form. The object form adds an
opt-in response policy. The callback receives the stable original request
(`toolName`, typed/raw tool input, `callId`, `requestId`), the submitted `{ decision: "approve" }`, verified responder,
read-only session identity/lineage, and only `auth.getToken` / `auth.requireAuth`.
It receives no sandbox, skill, model, channel, execution, or mutable-state
capability.

The default interaction is **Allow / Cancel**. Allow invokes the response policy;
Cancel is ordinary authenticated conversation flow control and does not. An
Allow candidate may be allowed, rejected with an authored `safeReason`, parked
on an authorization challenge, failed, timed out, or made stale by another
terminal settlement. Errors fail only that candidate and fail closed. Durable
stream events carry candidate and settlement lifecycle; delivery only
acknowledges ingestion.

## Required invariants

1. **Verified responder only.** A response policy receives the identity
   derived by the authenticated ingress route/webhook, never body-supplied
   identity.
2. **No unauthorized terminal effect.** A rejected responder cannot Allow,
   clear, or otherwise settle the pending request. Cancel follows normal
   authenticated conversation flow control.
3. **Candidate binding.** An Allow challenge is bound to `{ requestId,
responder principal }`. A callback or later delivery from another user
   cannot settle that candidate.
4. **Single winner.** Concurrent/retried clicks settle a request at most once.
   A stale candidate completing after another valid response is harmless.
5. **Durability.** A restart survives the original approval, candidate
   response, challenge wait, and retry point.
6. **No optimistic closure.** Channels may only replace/disable an approval
   card after an accepted terminal response. Rejection leaves shared controls
   available.
7. **Channel agnosticism.** Slack, custom channels, and `eve/client` carry the
   same responder context and consume the same durable lifecycle events.
   Subagent proxies preserve identity for the child request.
8. **Per-request authorization, batch-gated execution.** Every candidate is
   authorized and settled independently, but tool execution/model continuation
   waits until the original input batch is terminal.
9. **Durable-first settlement.** Terminal state and audit history commit before
   best-effort channel notification; notification failure cannot roll back the
   decision.

## PoC plan

### 1. Provide GitHub approver auth for hosted and self-hosted agents

The PoC has the same response-authorizer contract in both environments: it
uses a normal user-scoped eve auth provider to obtain a human GitHub identity.
Only the provider implementation and token ownership differ.

| Deployment                     | Agent write credential                                                | Responder identity credential                                                                  |
| ------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Vercel-hosted / Connect-linked | Existing GitHub App installation token                                | New `github-tools` eve provider backed by Connect's GitHub **user** subject                    |
| Self-hosted                    | Existing `token` / `GITHUB_TOKEN` / authored async app-token provider | Author-provided `defineInteractiveAuthorization` GitHub OAuth provider and durable token store |

**Vercel-hosted path.** The Connex source confirms that the GitHub connector
has the required user OAuth implementation:

- `GitHubConnexClientDriver.supportedSubjectTypes` includes `user` and `app`;
- `userTokens.getAuthorizationUrl` redirects to
  `https://github.com/login/oauth/authorize` and `completeAuthorization`
  exchanges the OAuth code for the human's user token;
- `userTokens.getUserInfo` calls GitHub `/user` and returns `sub` as the
  stable numeric GitHub ID;
- user tokens are stored and keyed against the requested Connect user subject;
  app tokens are separately minted from the GitHub App installation.

Extend `@github-tools/sdk` with an eve-facing Connect user provider. It should
request a token for the active responder principal, call `getTokenResponse()`
(not only `getToken()`), map `UserAuthorizationRequiredError` to eve's existing
interactive authorization signal, and use `externalSubject` or `/user` as the
stable approver ID. Retain `connectGithubToken()` for app-scoped execution.

This hosted path needs no agent-owned OAuth client, link table, or token store:
Connex durably associates the GitHub grant with the responder subject.

**Self-hosted path.** Do not make Connect a requirement. The GitHub approver
helper accepts an authored `ToolAuthProvider`, including an
`defineInteractiveAuthorization` provider that implements GitHub OAuth. eve
already hosts the OAuth callback and challenge/park/resume lifecycle. The
self-hosting application supplies its GitHub OAuth client configuration and
durable per-principal token lookup/store; `github-tools` uses the resulting
user token only to identify and authorize the approver. The PoC documents this
provider shape but does not add a generic token database or managed OAuth
service to eve or `github-tools`.

### 2. Add durable response authorization in eve

Implement the response authorizer on both authored tools and connection tools.

- Extend public approval definitions and validation to accept the new
  request-time + response-time configuration while retaining existing function
  shorthand for request-time policies.
- Preserve the original approval request/action data in pending HITL state so
  the callback receives a stable request even after a deployment/restart.
- Add an auth-only callback context backed by the same scoped authorization
  machinery used by `ToolContext.getToken()` (`execution/tool-auth.ts` and
  `runtime/connections/scoped-authorization.ts`).
- Represent a candidate response and auth wait explicitly in durable state;
  do not overload a successful approval record.
- On callback completion, retry validation of the candidate response before
  recording approved tools, clearing the pending request, or appending terminal
  tool-response history.
- Keep authorization policy resolution live rather than serializing callbacks:
  a resumed session resolves the currently deployed tool/connection definition.

### 3. Add durable candidate and settlement events for channels and clients

Delivery acknowledges ingestion only. Emit correlated durable stream events for
candidate pending, authorization-required, rejected, failed, timed-out, and
stale outcomes, plus terminal request settlement. Persist settlement history so
channels can repair stale UI later; a mandatory notification outbox is not part
of the first pass.

For Slack specifically:

- acknowledge the Slack webhook immediately;
- show candidate-specific checking, OAuth, and `safeReason` feedback only to
  the authenticated responder;
- leave shared controls actionable while any Allow candidate is nonterminal;
- replace/disable the card only after accepted durable settlement;
- render **Allow / Cancel**, with Cancel using normal interaction auth.

`eve/client`, hooks, custom channels, and subagent proxies consume the same safe
stream lifecycle; ephemeral Slack delivery is not a core API.

### 4. Implement the GitHub policy in `github-tools`

Add a GitHub-specific approver policy/helper that composes with the eve
response-authorizer API and is opt-in on GitHub write tools.

Initial eligibility is a showcase repository-role check, not CODEOWNERS. Apply
GitHub `write` permission only to a narrow allowlist of issue/comment/label-style
operations. Exclude branch-sensitive, merge, protected-ref, workflow-definition,
repository-administration, repository creation/fork, and gist operations.
GitHub's native enforcement against the agent App remains authoritative.

The helper should:

- use a responder-scoped GitHub auth provider solely to identify the human
  GitHub account; this is Connect user OAuth on Vercel or an author-supplied
  interactive provider when self-hosted;
- use the configured agent credential (Connect installation token on Vercel,
  or the existing token/provider when self-hosted) to read repository policy
  as needed and perform the eventual write;
- return an explicit `safeReason`, never an execution error, for an ineligible
  responder;
- keep `requireApproval` and optional `authorizeApprovalResponse` separate;
  omission preserves existing request-time-only behavior, and a per-tool map
  opts only supported operations into responder authorization.

Likely touch points in `github-tools` are `packages/github-tools/src/eve/types.ts`,
`eve/approval.ts`, `eve/build.ts`, the Connect helpers, and the eve extension
configuration/schema. The exact option belongs in that repository after the
GitHub credential capability is confirmed.

### 5. Test the end-to-end state machine

Add eve unit/integration coverage for:

- accepted Allow and unauthorised Cancel, including their atomic race;
- rejected Allow with the request still pending;
- missing GitHub authorization -> `authorization.required` -> callback ->
  retry/accept or retry/reject;
- silent duplicate delivery and concurrent candidates; only one terminal
  settlement;
- callback after another responder settles, cancellation, stale continuation,
  and process/redeploy recovery;
- batched requests: independent candidate outcomes do not lose unrelated
  requests, and execution remains batch-gated;
- subagent-proxied approval and responder auth;
- Slack card behavior and private rejection feedback; client/custom-channel
  structured outcome.

In `github-tools`, test that the helper identifies the responder using the
human credential, reads policy with the agent credential, and maps each
eligible/ineligible result to eve's response-authorizer outcomes.

## Recorded decisions

### Settlement ordering

Durable settlement happens first. After the authorizer allows a response, eve
atomically records the terminal settlement before emitting a best-effort channel
notification. Channel delivery failure cannot roll back or block an otherwise
valid approval.

Accepted settlement remains available as durable history for logging and
observability, and channels can use that history to repair stale UI later. A
mandatory durable notification outbox is not required for the first pass.

### Batched approval responses

Authorize and settle each candidate independently. One delivery may produce
mixed accepted, rejected, authorization-required, and stale outcomes; accepted
responses must not be held back by unrelated candidates that remain pending.
No unvalidated response may flow through merely because another response in the
same delivery was accepted.

Avoid creating approval batches whose requests have dramatically different
response-authorization requirements. Tool and agent design should separate such
operations where practical, but runtime correctness must not depend on authors
doing so.

Accepted candidates are recorded durably per request, but tool execution and
model continuation remain gated until every request in the original input batch
has reached a terminal accepted settlement. This preserves current provider and
AI SDK batch-history constraints while keeping authorization decisions
independent.

### Missing response authorizer after deployment change

Fail closed and retain the request when durable pending state says response
authorization is required but the current deployment cannot resolve the tool or
its authorizer. Never silently downgrade to ordinary approval settlement.
Surface a safe, nonterminal retry message to the responder, retain the request
for deployment repair or explicit cancellation, and record detailed tool/policy
resolution diagnostics for operators and observability.

### Concurrent candidates

Allow multiple responders to validate independently against the same pending
request. Each candidate and authorization challenge is durably bound to its
request ID, proposed decision, and authenticated responder principal. The first
allowed candidate to settle wins atomically; every later completion is stale and
has no terminal effect.

Rejected, failed, timed-out, or abandoned candidates do not block other
responders. Candidate-specific status, OAuth challenges, and rejection feedback
remain private to that responder while the shared approval control stays
available until a winner settles it.

### Response-authorizer capability boundary

Expose a narrow auth capability plus read-only session metadata. The callback
receives the stable request, verified responder, proposed decision,
`auth.getToken` / `auth.requireAuth`, and read-only session identity and lineage
(`id`, `auth.initiator`, `parent`, and `turn`). It does not receive sandbox,
skills, model, channel, tool execution, or mutable session-state capability.

Keep the verified current responder separate from the session initiator. Both
are available so policies can intentionally distinguish the person attempting
to settle the response from the person who initiated the session.

### Authorizer errors and timeouts

Fail only the candidate, nonterminally. An authorizer timeout or unexpected
error never consumes or settles the request, never blocks concurrent
candidates, and does not trigger automatic retries of arbitrary policy code.
Keep shared controls available and give the responder generic private retry
feedback; record detailed errors only for operators and observability.

Apply a 10-second timeout to each authorizer attempt. An explicit
authorization-required result is not an authorizer error and keeps its candidate
durably pending through the normal challenge lifecycle.

### Approval decisions and conversation escape hatch

The default approval interaction is **Allow / Cancel**. Allow is the only
policy-authorized decision: it runs the response authorizer and may execute the
action after acceptance. Cancel means “do not run this proposed tool call and
continue once the batch resolves”; it does not invoke the response authorizer
or claim an authoritative policy denial.

Treat Cancel like ordinary authenticated conversation flow control. It needs no
additional approval-specific authorization beyond the channel's normal ingress
and interaction authorization, consistent with eve's existing cancel/reset
surfaces. Record the authenticated actor for audit and observability. A
specialized, policy-authorized Deny action is not part of the first-pass default
contract.

### Rejection and error feedback

Show an authorizer's explicit safe rejection reason verbatim and privately to
the candidate responder. Name the public result field `safeReason` to make its
presentation semantics clear. Authors must not place credentials, sensitive
policy data, or operator diagnostics in it.

Never expose thrown errors, timeout details, provider payloads, or internal
diagnostics directly. Map those failures to generic private retry feedback and
retain full details only in operator logs and observability.

### Candidate lifetime and abandoned authorization

Expire a candidate with its authorization challenge. Use the provider/challenge
expiry when available and a 10-minute eve fallback otherwise. Expiry marks only
that candidate timed out; it does not settle or block the shared request, and a
responder may start a fresh candidate.

A callback after expiry or after another candidate settles is stale and
harmless. Retain timed-out and stale outcomes in durable history and
observability while allowing expired candidate state to be cleaned up.

### Duplicate candidate delivery

Deduplicate active candidates by `{ requestId, decision, responder principal }`.
A repeated click while that candidate is validating or waiting for
authorization creates no new candidate, runs no authorizer work, emits no new
feedback, and does not re-deliver or refresh the authorization challenge.

After the candidate expires or reaches a failed/rejected terminal outcome, a
later click may create a fresh candidate.

### Cancel racing active candidates

Cancel and allowed candidates share one atomic terminal-settlement race. If
Cancel settles first, the action does not run, every active Allow candidate is
invalidated, and later authorization callbacks are stale and harmless. If an
allowed candidate settles first, a later Cancel is stale.

Active validation never blocks Cancel, and Cancel cannot revoke an Allow after
accepted durable settlement.

### Deployment changes during validation

Resolve and re-run the currently deployed response authorizer whenever a
candidate resumes, including after authorization callback. Durable state stores
request and candidate data, never callback code or a pinned policy revision.
Policy fixes and restrictions therefore apply immediately to in-progress
candidates.

If the current tool or authorizer cannot be resolved, follow the recorded
fail-closed behavior and retain the request. Do not route execution to old
deployment code or automatically invalidate every candidate solely because a
deployment changed.

### Durable audit history and retention

Persist structured candidate attempts and terminal settlements under the normal
eve session/run retention policy rather than introducing a separate identity or
audit database. Records include candidate/request IDs, proposed decision,
verified responder principal identifiers, status, timestamps, safe rejection
reason, authorization provider label when safe, and an observed policy/runtime
revision for diagnostics only. Terminal settlement records the winning actor or
cancelling actor and outcome.

Retain rejected, failed, timed-out, and stale attempts as well as the winner.
Never persist OAuth URLs, authorization codes, access or refresh tokens, PKCE
secrets, raw provider errors, or broad responder attributes by default.

### Subagent responder identity and policy ownership

Preserve the verified root-channel responder through the trusted proxy chain to
the child. The child owns the pending request and candidates, resolves and runs
its currently deployed response authorizer, owns authorization challenges and
callbacks, records canonical audit history, and executes the tool. The parent
and root own routing and presentation, not policy decisions.

For local subagents, use the existing capability-protected durable hook path and
delivery-time auth propagation. For remote agents, forward responder identity
only through the existing opt-in trusted-forwarder boundary; validate and
audit-stamp the forwarding hop, and fail closed when the remote does not accept
forwarded principals.

Keep canonical candidate and settlement history in the child. Persist a durable
root-session projection containing the child/request/candidate correlation,
safe status needed for responder feedback, and settlement coordinates for
unified observability and UI repair, without creating a second authoritative
policy record.

### Public channel and client outcome contract

Durable stream events are the canonical candidate and settlement outcome
surface. Delivery acknowledges ingestion only; it does not wait for or return a
final policy result, because authorization may complete long after the inbound
request and webhook acknowledgement.

Expose correlated lifecycle events for candidate pending,
authorization-required, rejected, failed, timed-out, and stale outcomes, plus
terminal request settlement. Include only safe presentation fields on the
public stream. Slack, `eve/client`, custom channels, hooks, and subagent proxies
consume the same lifecycle. A future immediate command-result API may add
correlation convenience without replacing stream-event authority.

### Cancellation wire semantics

Change the approval option ID directly from `"deny"` to `"cancel"`. Render and
persist Allow/Cancel consistently across the protocol, history, events, clients,
and channels. This is an intentional pre-1.0 breaking change; do not retain a
legacy `"deny"` fallback after migration.

### github-tools first-pass eligibility scope

Ship the repository-role policy as a showcase for a narrow allowlist of
repository-scoped operations whose authorization is honestly approximated by a
repository role, initially issue/comment/label-style actions. Default the
minimum GitHub permission to `write` and identify the human with the
user-scoped credential while reading policy and executing with the separate
agent credential.

Do not apply this default policy to branch-sensitive, merge, protected-ref,
workflow-definition, repository-administration, repository-creation/fork, or
gist operations. Repository `write` does not imply authority over `main`,
CODEOWNER status, ruleset satisfaction, or branch-protection bypass. Preserve
GitHub's native enforcement against the agent GitHub App and document this as a
showcase repository-role check, not CODEOWNERS authorization.

### Hosted provider identity evidence

Extend eve's owned `TokenResult` with an optional `providerSubject`: the stable
subject for the provider account represented by the credential. The
`@vercel/connect/eve` adapter uses `getTokenResponse()` and maps Connect's
`externalSubject` into that eve-owned field without exposing the full Connect
response or third-party API. Self-hosted providers may return equivalent
subject evidence.

github-tools may use this evidence as the stable GitHub account identifier and
fall back to GitHub `/user` only when a provider does not supply it. Token
ownership and identity evidence remain distinct from the app-scoped execution
credential.

### Self-hosted provider responsibility

Document the ordinary eve `ToolAuthProvider` contract rather than shipping a
GitHub OAuth helper or token store in the first pass. Self-hosted applications
may supply their own `defineInteractiveAuthorization` provider, OAuth client
configuration, durable token persistence, refresh/revocation behavior, and
optional stable provider subject. github-tools consumes the provider without
owning those concerns.

Keep responder authorization opt-in. Applications that do not configure an
approver provider retain the existing request-time HITL behavior with no
response-time identity or eligibility check; do not make Connect or self-hosted
OAuth mandatory for existing github-tools users.

### github-tools opt-in authoring shape

Keep request-time approval and responder authorization as separate options.
`requireApproval` continues to control whether a tool call prompts, while an
optional `authorizeApprovalResponse` accepts a generic eve response authorizer
or per-tool map. Omitting it preserves existing request-time HITL semantics with
no responder identity or eligibility check.

Provide composable helpers such as `githubRepositoryApprover({ auth,
agentToken, minimumPermission })` and `connectGithubApproverAuth(connector)`, but
do not infer response authorization from environment or token type. Once an
authorizer is configured for a request, provider/configuration failure is
fail-closed and never falls back to legacy settlement. Warn or reject when a
response authorizer is configured for tools whose request-time approval is
disabled.

## Remaining open questions

1. **Public API naming.** Finalize names for the object-form request policy,
   response authorizer, candidate events, and terminal settlement event.
   `TokenResult.providerSubject` is decided.
2. **Connection-tool lookup.** Specify the durable policy-required marker and
   live definition resolver uniformly for authored, dynamic, framework, and
   connection-derived tools so a missing authorizer always fails closed.
3. **Batch execution bridge.** Define the exact AI SDK/provider history shape
   for per-request durable settlement while execution/model continuation stays
   gated on the original batch.
4. **Candidate expiry scheduling.** Decide whether timeout events are emitted by
   a scheduled durable wake-up or lazily when the request is next touched. The
   10-minute fallback semantics are fixed.
5. **Root projection schema.** Finalize which safe child candidate fields and
   stream coordinates are copied into root durable history for observability
   and UI repair.
6. **Showcase allowlist.** Finalize the exact github-tools operations covered by
   the repository-`write` helper; issue/comment/label-style scope is decided,
   but the concrete names need API review.

## Implementation map and starting references

### eve: public approval and response settlement

| Area                                 | Start here                                                                      | Why it matters                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request-time approval API            | `packages/eve/src/public/definitions/approval.ts`                               | `Approval`, `ApprovalContext`, and `ApprovalStatus` are the existing function-only request-time contract. Extend it without breaking function shorthand.                                                                                                                                                                     |
| Tool public type and overloads       | `packages/eve/src/public/definitions/tool.ts`                                   | `ToolDefinition.approval`, `ToolContext`, and `defineTool()` overloads need the response-authorizer configuration and its narrower auth context. Connection definitions use the same `Approval` type.                                                                                                                        |
| Current irreversible HITL transition | `packages/eve/src/harness/input-requests.ts`                                    | `resolvePendingInput()` presently records approved tools then clears the whole pending batch. This is the point that must validate a candidate response first. `PendingInputBatch`, `recordApprovedTools()`, `buildToolResponseParts()`, and `buildRejectedActionBatch()` define the state/history consequences to preserve. |
| Pending request schema               | `packages/eve/src/runtime/input/types.ts`                                       | Inspect `InputRequest` / `InputResponse` before deciding whether request metadata must be expanded or can be retained separately.                                                                                                                                                                                            |
| Runtime tool assembly                | `packages/eve/src/harness/tools.ts` and `packages/eve/src/harness/tool-loop.ts` | These resolve authored tool/connection definitions, approval keys, and tool execution. They are the likely bridge from a durable request back to the current response-authorizer callback after restart/redeploy.                                                                                                            |

### eve: reuse—not duplicate—the authorization challenge machinery

| Area                                             | Start here                                                                                                                                     | Why it matters                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth-capable tool wrapper                        | `packages/eve/src/execution/tool-auth.ts`                                                                                                      | `createToolExecuteWithAuth()` builds `ToolContext.getToken()` / `requireAuth()`, catches authorization-required failures, and returns a park signal. The response-authorizer needs a deliberately narrower analogue, not a second OAuth implementation.                                         |
| Shared token/cache/principal/challenge mechanics | `packages/eve/src/runtime/connections/scoped-authorization.ts`                                                                                 | `resolveScopedToken()`, `startScopedAuthorization()`, and `completeScopedAuthorization()` already bind a user principal, cache by `(scope, principal)`, create a callback challenge, and complete it after resume. Reuse these semantics while binding the challenge to the approval candidate. |
| Authorization signal and durable callback model  | `packages/eve/src/harness/authorization.ts`                                                                                                    | `requestAuthorization()`, `getAuthorizationResult()`, and `getHookUrl()` define the framework signal. Its header explains what survives an OAuth park and why Connect strategies do not need to journal PKCE state.                                                                             |
| Authorization persistence / resume               | `packages/eve/src/harness/authorization.ts`, `packages/eve/src/execution/workflow-entry.ts`, and `packages/eve/src/execution/turn-workflow.ts` | Follow the existing `setPendingAuthorization` / callback-resume path before adding a candidate-response state machine. Search these files for `PendingAuthorization` and `authorization.required`.                                                                                              |
| Self-hosted provider contract                    | `docs/connections/overview.mdx` under **Self-hosted interactive OAuth**, plus `packages/eve/src/runtime/connections/types.ts`                  | `defineInteractiveAuthorization` documents the host-owned token lookup, PKCE/start, and code exchange contract. Eve owns callback/park/resume; do not add a second self-hosted OAuth system.                                                                                                    |
| Hosted Connect semantics                         | `docs/guides/auth-and-route-protection.md` under **Tool and connection auth**, and `docs/connections/overview.mdx`                             | Documents `ctx.getToken(connect(...))`, `authorization.required`, user vs app principals, and the current order of approval then sign-in that this feature must change for approver validation.                                                                                                 |

### eve: delivery, UI, and subagent paths

| Area                      | Start here                                                                                                             | Why it matters                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack response ingress    | `packages/eve/src/public/channels/slack/interactions.ts`                                                               | Signed Slack actions are converted to `{ inputResponses }` plus `buildSlackAuthContext(...)`. It currently schedules `updateAnsweredHitlCard()` immediately; response acceptance must drive that update instead. |
| Slack HITL rendering      | `packages/eve/src/public/channels/slack/hitl.ts` and `packages/eve/src/public/channels/slack/defaults.ts`              | Native cards, request IDs, and default `input.requested` rendering. Preserve cards after a rejected candidate.                                                                                                   |
| Channel delivery contract | `packages/eve/src/channel/types.ts`                                                                                    | `DeliverHookPayload` carries delivery-time auth through the durable hook. Any accepted/rejected/stale outcome should be designed alongside this contract.                                                        |
| HTTP/client path          | `packages/eve/src/public/channels/eve.ts`, `packages/eve/src/client/session.ts`, and `docs/guides/client/messages.mdx` | `inputResponses` are accepted through the default HTTP channel/client. Add equivalent structured feedback rather than relying on Slack ephemerals.                                                               |
| Subagent routing          | `packages/eve/src/execution/subagent-hitl-proxy.ts` and `packages/eve/src/harness/proxy-input-requests.ts`             | Input response IDs are routed from the root channel to a parked child. Preserve responder auth and candidate/challenge ownership through this proxy.                                                             |

### `github-tools`: current credential and approval integration

The checked-out research source is `/var/folders/yh/8gqnf245537683p2rnghc2rh0000gn/T/tmp.F6f7RJ9E4d/github-tools`; obtain a fresh clone of `vercel-labs/github-tools` before implementation.

| Area                          | Start here                                                                                                | Why it matters                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Connect token helper | `packages/github-tools/src/connect/token.ts`                                                              | `connectGithubToken()` calls plain `@vercel/connect.getToken()`. It is not an eve auth provider and cannot emit `authorization.required`.                                                                   |
| Why it is app-scoped          | `packages/github-tools/src/connect/params.ts` and `connect/types.ts`                                      | `buildConnectTokenParams()` pins `subject: { type: "app" }`; this is the agent installation credential, not the approver credential.                                                                        |
| Eve tool construction         | `packages/github-tools/src/eve/build.ts`                                                                  | Builds each `defineTool()` with a request-time `approval` and an execute closure that uses the pre-resolved token resolver. Its `TODO(eve-auth)` explicitly notes the missing eve-managed auth integration. |
| Approval mapping              | `packages/github-tools/src/eve/approval.ts` and `eve/types.ts`                                            | Maps `requireApproval` and overrides to eve's current request-time `Approval`; extend this mapping for the GitHub approver policy without disrupting existing users.                                        |
| Agent token fallback          | `packages/github-tools/src/core/token.ts`                                                                 | Self-hosted execution currently resolves `token` / `GITHUB_TOKEN` or an async agent-token supplier, with no session/principal input. Keep this behavior for the write credential.                           |
| Public hosted setup docs      | `apps/docs/content/docs/3.guide/4.tokens-and-auth.md` and `packages/github-tools-eve-extension/README.md` | Documents Connect as a Vercel-hosted installation-token path and static token fallback; update the description when adding responder identity auth.                                                         |

### Connect / Connex evidence for the hosted user OAuth path

These source files are in `/Users/ben/repos/api/wt1`; they establish that the
native GitHub Connect connector supports both credentials needed by the hosted
PoC.

| Area                        | Start here                                                 | Why it matters                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub driver subject modes | `packages/connex/src/client-types/github/client-driver.ts` | Declares `supportedSubjectTypes: ["user", "app"]`. `resolveAppToken()` mints the installation token; `getAuthorizationUrl()` and `completeAuthorization()` implement GitHub user OAuth; `getUserInfo()` calls `/user` and returns numeric GitHub ID as `sub`. |
| Connect token response      | `node_modules/@vercel/connect/dist/token.d.ts`             | `getTokenResponse()` returns `externalSubject`; `getToken()` discards it. Use the former for approver identity.                                                                                                                                               |
| Connex returned identity    | `packages/connex/src/connex-token.ts`                      | `externalSubject` is read from stored authorization/token metadata and returned with a token. `getConnexTokenInfo(..., { fetchUserInfo: true })` exposes OIDC-style user info.                                                                                |
| Hosted OAuth behavior docs  | `apps/connex-docs/docs/dataflows-oauthgateway.md`          | Explicitly documents GitHub user ID as provider `sub`; useful confirmation of stable identity semantics.                                                                                                                                                      |

## Future seam, deliberately not a v1 feature

The eve response-authorizer contract is the two-way door. A later real-world
enterprise integration can provide its own evidence/eligibility decision at
that boundary. Do not publish a generic identity-directory framework until a
concrete integration establishes the required lifecycle and data model.
