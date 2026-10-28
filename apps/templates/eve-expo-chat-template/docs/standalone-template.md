# Setup and deployment

## Requirements

- Node.js 24.3+ and pnpm (the package manager version is pinned in `package.json`).
- A Vercel account and the Vercel CLI.
- Sandbox and Drives access in the linked Vercel project.
- Your own Expo/EAS account and native build credentials if you want native push.

The template is independent of the eve monorepo. Copy this entire directory, including its `packages/`, `apps/`, and `pnpm-lock.yaml`. All `link:` dependencies stay inside the copied directory; `eve` itself is a published npm dependency. There are no imports, symlinks, or tarballs pointing to the eve-start checkout.

## Provision

Start with a new project. This prototype does not migrate existing relay installations or copy Drives between projects.

```sh
vercel login
./scripts/setup.sh
# Or: ./scripts/setup.sh --scope YOUR_TEAM
pnpm deploy
```

The shell entrypoint installs dependencies from the lockfile and links a Vercel project if necessary. Its TypeScript provisioner uses the linked project's Vercel OIDC identity to:

1. Generate or preserve the agent identity, strong server credential, and web password.
2. Create or reuse an automation bypass if deployment protection requires one.
3. Write credentials to ignored `.env.local` with mode `0600`.
4. Initialize SQLite on the project-owned `eve-start-storage` Sandbox and Drive.
5. Install and validate a clean browser image, snapshot it, and record its ID in the database.
6. Save encrypted environment variables for Production, Preview, and Development.
7. Install the deployment warm-up hook without replacing other postdeploy commands.

No registration server, team allowlist, OAuth app, or third-party database account is required. An explicit `DATABASE_URL` continues to select external Postgres instead of provisioning SQLite; setup does not migrate existing data.

Reruns preserve credentials, profiles, customized extension mounts, and matching browser images. Conflicting local/deployed agent credentials or identities stop setup rather than rotating access to existing storage. Environment changes take effect on the next deployment.

**Preview and production are not isolated:** the current implementation shares project-scoped storage/browser names and installs the same credentials into all environments. Use a separate Vercel project for isolated testing.

## Pair a phone

Install Expo Go on the phone. Authenticate to the web dashboard, choose **Open on mobile**, and scan the QR with the iPhone camera or the Expo Go app on Android. Expo Go loads the mobile app from the deployment, shows the agent's address, and asks you to **Connect agent**. No Expo account or EAS build is required.

`pnpm build` exports the Expo client for iOS and Android and embeds it in the deployment. The deployment serves an Expo Go manifest at `/start/mobile` and the bundle and assets under `/start/mobile/files/`. The QR has the form `exps://DEPLOYMENT/start/mobile/--/pair?app=…&token=…`: Expo Go loads the manifest from the part before `/--/` and delivers the `/pair` route to the app on launch.

The manifest and bundle are public client code; they contain no credentials. The pairing link contains the deployment origin, a random 256-bit one-use ticket, and (when needed) a deployment-protection bypass for API requests. Tickets expire after 90 seconds. The app redeems the ticket directly at the deployment's `/v1/pair` endpoint and stores the issued device credential in SecureStore. It never receives the server's agent credential. Treat the QR and pairing link as credentials: do not publish, log, or commit them.

Expo Go cannot send Vercel Deployment Protection bypass headers when loading the app, so use a deployment URL that is not protected, such as the production domain. The phone must be able to reach that URL. Use an Expo Go version that supports the template's Expo SDK.

### Develop the mobile app

Run `pnpm mobile:go --lan`. Under **Open on mobile → Developing the mobile app?**, enter the `exp://` URL from the terminal and click **Update QR**. The QR then loads your local Metro bundle instead of the deployed one, and still pairs with the agent. Keep Metro running and the phone on the same network. Enter only a Metro server you control: it supplies the JavaScript that receives the pairing ticket.

If a build has no embedded export, the QR falls back to an `eve-go://pair` link for an installed native build. Either link can also be pasted into a running client.

## Native builds and push

Configure your own values in `apps/mobile/.env.local` or your build environment:

```dotenv
EXPO_OWNER=your-expo-account
EXPO_APP_SLUG=your-agent
EXPO_APP_NAME=Your Agent
EXPO_APP_ID=com.yourcompany.youragent
EXPO_PUBLIC_EAS_PROJECT_ID=your-eas-project-id
```

Initialize your EAS project, configure native notification credentials, then build with `pnpm mobile:build`. Use `pnpm mobile` to start Metro for a development client. Expo Go supports chat and in-app alerts but not this native push path.

The deployment submits notifications directly to Expo with its existing persistent outbox/retry mechanism. If Expo push security is enabled, install `EXPO_ACCESS_TOKEN` in the **Vercel server environment**, then redeploy. Do not include that secret in mobile configuration.

## Local development

Run `pnpm dev`. The dashboard is at `http://localhost:2000/start`, using a local SQLite file for chat. The dev server uses the same cloud browser as your deployment, with the same profile and sign-ins. At startup it pulls a fresh Vercel project identity into its environment without rewriting `.env.local`; the identity lasts several hours, so restart `pnpm dev` if the browser stops responding after a long session. The dev server and the deployment can both use the browser; avoid giving them overlapping browsing tasks at the same time.

`pnpm dev` also embeds the mobile export. For phone access to local development, expose the dev server through an HTTPS tunnel, set `appUrl` in `agent/extensions/start.ts` to the tunnel origin, and open the dashboard there before scanning. The dev server listens only on localhost, which a phone cannot reach.

## Customize

- Agent model: `agent/agent.ts`.
- Persona: `agent/instructions.md`.
- Dashboard options: `agent/extensions/start.ts`.
- Browser runtime/storage: the private implementation under `packages/start/`.
- Mobile UI/configuration: `apps/mobile/`.
- Resource provisioning: `apps/cli/src/init.ts`, invoked by `scripts/setup.sh`.

Normal eve schedules can use the browser and notification tools for proactive background checks. Browser selection is pinned per turn; switching environments does not redirect already-started operations to another browser.

## Validation boundaries

`pnpm typecheck` builds the local extension before checking source and mobile types. `pnpm build` builds the extension and eve app without provisioning a cloud browser. Tests cover the hosted Expo Go manifest and bundle hashes, Expo Go/native link parsing, direct pairing, authorization, shared chat, direct push submission, database persistence, and setup credential preservation. They do not prove that Expo Go on a physical phone runs the exported bundle; validate scanning on a device.

Setup tests mock the Vercel CLI/provisioner; app API tests use local SQLite. Neither proves live Vercel Sandbox/Drive provisioning, physical-device pairing, or native notification delivery. Validate those against your own project before relying on this prototype.
