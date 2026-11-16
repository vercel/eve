# Architecture

A map of Kody, the GitHub maintainer eve template. The agent is defined under `agent/`; eve discovers capabilities from the filesystem.

## Supported entry points

| Entry point          | Behavior                                                                                                                                  | Authorization boundary                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weekly digest        | Monday 09:00 UTC (`0 9 * * 1`): reads open issues on `DIGEST_REPO` and sends a digest to `DIGEST_EMAIL` through the Resend MCP connection | Operator-configured schedule, repository, recipient, and sender                                                                                                                                                                            |
| GitHub @Kody mention | Answers issue, PR timeline, and review comments in-thread                                                                                 | Verified Connect webhook; repository must match `DIGEST_REPO`; comment author must match the sender; a fresh GitHub collaborator-permission API lookup must confirm write, maintain, or admin access for that same user on that repository |
| Linear Agent Session | Works on delegated or mentioned issues; adds the requester's name and email to context                                                    | Linear channel through Connect                                                                                                                                                                                                             |
| eve route / dev TUI  | Direct authenticated sessions                                                                                                             | `vercelOidc()` in production; a `localDev()`-based user shim for development                                                                                                                                                               |
| Inbound email        | Rejects every POST to `/eve/v1/resend` with HTTP 403, without reading mail or starting a session                                          | Disabled in code, including replies to previously subscribed threads                                                                                                                                                                       |
| PR opened            | No automatic session or summary                                                                                                           | No `onPullRequest` dispatch hook                                                                                                                                                                                                           |

GitHub mention permission errors fail closed. A historical `author_association`, organization membership without repository write access, or a role on an unrelated repository does not authorize shared integration access. The operator must trust maintainers of `DIGEST_REPO` with this installation's GitHub, app-scoped Linear, and Resend authority. This is not per-user Linear consent.

Inbound email commands are intentionally disabled by default pending a separately authenticated authorization protocol bound to this installation. There is no email opt-in or exported dispatch helper. Resend webhook signatures authenticate transport, not caller authority. `From` addresses, recipient matching, thread headers, and approval prompts alone cannot authorize commands. Remove legacy inbound webhook deliveries and queued retries.

Automatic outside-contributor PR summaries require a future isolated read-only agent without maintainer, Linear, or Resend tools, plus a bounded host-side publisher. A summary-only prompt on the privileged root agent is not an authorization boundary.

## Component map

```text
agent/
  agent.ts                  # model, compaction, session usage limit
  instructions.ts           # behavior; build-time sender identity
  channels/
    github.ts               # configured-repo, API-verified maintainer mentions
    linear.ts               # Linear Agent Sessions via Connect
    resend.ts               # unconditional rejection of inbound email
    eve.ts                  # direct route auth and local dev shim
  connections/
    linear.ts               # app-scoped Linear MCP via shared linearAuth
    resend.ts               # outbound Resend MCP with static API key
  extensions/github.ts      # GitHub Tools maintainer preset via Connect
  schedules/weekly-digest.ts # outbound digest through the Resend connection
  sandbox.ts                # Vercel Sandbox environment
  tools/                    # research and principal-scoped preference tools
  subagents/researcher/     # isolated web researcher, reached via research tool
  skills/                   # writing, digest, triage, GitHub/Linear bridging
  lib/                      # required configuration, shared Linear auth, Blob keys
```

Tools run in the app runtime. Skills add instructions, not authorization. The researcher inherits none of the root agent's tools, skills, or connections; the research tool passes the facts needed by each task.

## Credentials and storage

- GitHub and Linear credentials are brokered by Vercel Connect (`GITHUB_CONNECTOR`, `LINEAR_CONNECTOR`). Linear uses shared app-scoped authorization with `read`, `write`, `issues:create`, and `comments:create` scopes.
- The outbound Resend connection resolves `RESEND_API_KEY` per call, including schedule sessions with no signed-in user. `RESEND_FROM_ADDRESS` is required; `RESEND_FROM_NAME` defaults to Kody.
- `DIGEST_REPO`, `DIGEST_EMAIL`, and the sender address are required at build time. Missing configuration fails discovery.
- Inbound email no longer needs `REDIS_URL` or `RESEND_WEBHOOK_SECRET`. Legacy Chat SDK dependencies remain installed but do not implement a reachable route.
- Preferences live in a private Vercel Blob store under `user-preferences/<hashed-principal>.md`. Tools derive keys from `ctx.session.auth.current`, never model input, and use authenticated SDK reads and writes. Replace old public stores and delete their public objects.
- Blob and model access use the project's OIDC identity. Credentials never enter model context. No application database is required.

## Remaining trust boundaries

Authorized sessions still have broad root-agent authority. Issue bodies, PR diffs, and tracker comments remain untrusted source material even when a maintainer requests work. Disabling unsolicited sessions reduces exposure; it does not make prompt injection impossible in authorized sessions or scheduled digests.

GitHub issue-conversation writes currently bypass approval; higher-impact writes retain the extension's approval defaults. Linear and Resend connections have no approval policy. `clear_user_preferences` requires approval. Approval is a separate control from caller authorization.

## Development and deployment

Use `eve deploy` for production. Connect triggers point at `/eve/v1/github` and `/eve/v1/linear`; do not configure inbound Resend delivery. The README's deploy button still targets the upstream repository, not this imported copy.

Run `pnpm validate` for lint, types, and discovery. Run `pnpm test` for private preference storage, real channel-handler authorization regressions, and the outbound schedule contract. `pnpm dev` provides the local TUI; schedules do not fire automatically in development. Trigger the digest with `POST /eve/v1/dev/schedules/weekly-digest`.

Local sandbox snapshot preparation requires linked Vercel credentials. `eve build --skip-sandbox-prewarm` checks compilation without producing deployable sandbox output.
