# Next.js with eve and Better Auth

This example owns a [Better Auth](https://better-auth.com/) email/password instance in the Next.js app and
uses the same session cookie to authenticate eve requests. The authored eve
channel maps the Better Auth user to an eve user principal before a turn runs.

## Run locally

Create the local environment file and replace the example secret:

```sh
cp .env.example .env
openssl rand -base64 32
```

Use the generated value for `BETTER_AUTH_SECRET`, configure Vercel AI Gateway
with `eve link` or `AI_GATEWAY_API_KEY`, then create the Better Auth tables and
start Next.js:

```sh
pnpm --filter framework-next-better-auth auth:migrate
pnpm --filter framework-next-better-auth dev
```

Open `http://localhost:3000`, create an account, and ask the agent “Who am I?”.
The `whoami` tool returns the principal established by
`agent/channels/eve.ts`.

## Minimum application setup

- `lib/auth.ts` creates the Better Auth instance and enables email/password.
- `app/api/auth/[...all]/route.ts` exposes Better Auth's HTTP handler.
- `lib/auth-client.ts` drives sign-up, sign-in, and sign-out in the browser.
- `agent/channels/eve.ts` validates the request cookie and converts the session
  user to an eve `SessionAuthContext`.
- `BETTER_AUTH_SECRET` must be the same in the Next.js and eve processes.
  `withEve()` starts the local eve process with the app environment.

The checked-in SQLite configuration is intentionally local-only. SQLite files
inside a serverless deployment are not durable or shared across instances.
Replace `better-sqlite3` with a durable database adapter before deploying this
example to production, while keeping the same channel bridge.
