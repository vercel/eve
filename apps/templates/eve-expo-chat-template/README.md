# eve Expo Chat Template

A personal agent with web and Expo chat, a persistent cloud browser, and SQLite storage on Vercel.

Deploy the agent to your Vercel project, sign in to your services in its cloud browser, and pair your phone from the web dashboard. Your project owns chat history, device credentials, browser profiles, and notification delivery.

## Setup and deploy

Requires Node.js 24.3+, pnpm, the Vercel CLI, and access to Vercel Sandbox and Drives in your project.

```sh
vercel login
./scripts/setup.sh
pnpm deploy
```

Setup links your Vercel project, generates credentials, provisions SQLite storage, and prepares a cloud-browser image. Rerunning setup preserves your credentials, data, browser profiles, and customized configuration.

Open `/start` on your deployment. The web password is saved in `.env.local` and printed after deployment warm-up. Setup also saves credentials as encrypted Vercel environment variables.

## Open on mobile

1. Install [Expo Go](https://expo.dev/go) on your phone.
2. In the web dashboard, choose **Open on mobile**.
3. Scan the QR with your iPhone camera or the Expo Go app on Android.
4. Confirm the agent address and tap **Connect agent**.

Your deployment serves the mobile app to Expo Go, and the QR carries a one-time pairing ticket. Scan a fresh QR if one expires. Open the dashboard on a deployment URL your phone can reach without Vercel Deployment Protection, such as your production domain; Expo Go cannot load the app from protected preview URLs.

For native builds and push notifications, configure your Expo/EAS project using the [setup guide](docs/standalone-template.md).

## Use the cloud browser

The agent browses in Chrome running in a Vercel Sandbox. Open the browser panel in the dashboard to watch it live, or choose **Open full browser** to sign in to services yourself. Sign-ins persist on a Drive across restarts, and the browser sleeps when idle and wakes when the agent needs it.

## Develop and customize

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:2000/start`. Local development keeps chat in a local SQLite file and uses the same cloud browser as your deployment, so your sign-ins carry over. `pnpm dev` refreshes your Vercel project identity at startup; run `vercel login` if it reports that the cloud browser is unavailable.

To work on the mobile app, run `pnpm mobile:go --lan`, then enter its `exp://` URL under **Open on mobile → Developing the mobile app?** to load your local changes.

| File                        | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `agent/agent.ts`            | Model and reasoning settings               |
| `agent/instructions.md`     | Agent persona and instructions             |
| `agent/extensions/start.ts` | Dashboard and browser configuration        |
| `apps/mobile/`              | Expo client and native build configuration |

Add tools and schedules using normal eve files. The app implementation lives in `packages/` and `apps/cli/` and builds alongside your agent.

Run the checks before deploying changes:

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Architecture

```text
Web dashboard / Expo app
              |
       Vercel deployment
       ├── eve + dashboard + authenticated app APIs
       ├── SQLite Sandbox ── persistent storage Drive
       ├── Chrome Sandbox ── persistent profile Drive
       └── Notification outbox ── Expo Push Service
```

The database and browser have independent lifecycles and resume on demand. The browser image contains the installed software; signed-in state lives on the profile Drive. Phones pair and communicate directly with your deployment.

Everyone using the app shares one agent, chat, and browser. Connector chat content expires after 72 hours. Production and preview deployments share project-scoped storage, browser profiles, and credentials; use separate Vercel projects for isolated environments.

## Prototype validation

The automated suite covers local SQLite APIs, the hosted Expo Go manifest and bundles, pairing links, notification submission, and mocked Vercel provisioning. Before relying on the prototype, validate hosted Sandbox/Drive provisioning, scanning with Expo Go on a physical device, and native push delivery in your own project.
