# Computer Use

An [eve](https://eve.dev) and Next.js app where you watch an agent operate a computer in its own sandbox. Describe a task, pick a device in the composer or leave it on **Auto**, and follow along in a floating window over the chat that you can drag anywhere or expand.

- **Browser**: a headless Chrome, driven with the [agent-browser](https://agent-browser.dev) extension (`@agent-browser/eve`). The agent reads the page's accessibility tree and acts on element refs.
- **Desktop**: a Linux desktop with Firefox, terminals, a calculator, and a text editor, driven with eve's built-in computer-use extension (`eve/extensions/computer-use`). The agent sees screenshots and acts on screen coordinates. computer_use launches Firefox and the terminal; `computer__launch_app` in `agent/extensions/computer/tools/` opens the other apps, which `agent/lib/desktop-apps.ts` lists and `agent/sandbox.ts` installs.

In Auto, the web app's `/api/device` route asks a decision model which device suits the first message, with the AI SDK's `decide` and Baseten's `baseten/elephant-1` through AI Gateway, and the chat keeps that device. If the decision fails, the chat starts on the browser.

The interface is built from [ui-sdk](https://ui-sdk.dev) components (`@ui-sdk/react`), styled in `apps/web/app/globals.css` after ui-sdk.dev's own look.

## Architecture

```text
chat + device picker → eve agent → Vercel Sandbox (headless Chrome, Linux desktop)
                                     ↘ live stream (port 3600) → live view, Take Over
```

Both extensions run in the agent's [sandbox](https://eve.dev/docs/sandbox): each chat gets its own [Vercel Sandbox](https://vercel.com/docs/sandbox) with 4 vCPUs, during local development and when deployed. The browser and the desktop (a virtual display inside the sandbox) run side by side in it, so nothing opens on your own screen. `agent/sandbox.ts` installs agent-browser, Chrome, and the desktop into the snapshot every sandbox starts from, so sessions start warm.

The [directory mounts](https://eve.dev/docs/extensions#override-a-contribution) in `agent/extensions/` wrap each browser action and `computer_use` so its result also carries a screen for the web app: a screenshot, the page URL, and the device's live stream. `toModelOutput` keeps all three out of what the model reads. The desktop tool also passes the screenshot to the model as an image, so it can see the screen without a separate `read_file` call. The browser mount also disables agent-browser's `close` tool, so the browser stays open after a task for you to watch or take over.

### Live view and Take Over

The first action on a device starts its live stream in the sandbox (`agent/lib/live.ts`). Both streams start from the app's own `/api/live` route (`apps/web/app/api/live/`), which first:

1. Refuses a request from another site's page, by its `Origin`.
2. Reads the eve session with the caller's own credentials, over a [service binding](https://vercel.com/docs/services/bindings) to the agent (`EVE_URL` in `vercel.ts`). If eve's channel auth refuses the caller, so does the live view.
3. Finds the session's sandbox by the `sessionId` tag eve gives it when it creates it. Nothing the sandbox writes into the session decides which sandbox a viewer reaches.

**Desktop.** [screen-relay](https://github.com/vercel-labs/screen-relay) attaches to the desktop's display and streams it as H.264 on its own public sandbox port, behind the sandbox's TLS proxy, as its [remote access guide](https://screen-relay.dev/docs/remote-access) describes. It requires a token, which stays on the server: `POST /api/live?session=…` uses it to get a [one-time ticket](https://screen-relay.dev/docs/remote-access#tokens), and the page connects to screen-relay directly with the ticket, which opens one connection within 60 seconds. The page decodes the stream with WebCodecs (`apps/web/app/screen-relay.ts`), so watching the desktop needs a browser with H.264 WebCodecs, such as current Chrome, Edge, or Safari. The browser learns the sandbox's address, which is useless without a ticket.

**Browser.** agent-browser streams the browser's screencast as JPEG frames. Its stream has no token and only accepts local pages, so a relay on the sandbox's port 3600 (`agent/lib/live-relay.cjs`) sits in front of it and requires a random token it writes inside the sandbox. The page opens `/api/live?session=…` as a WebSocket, and the route connects to the relay with the token and passes frames out and input in. Neither the token nor the sandbox's address reaches the page. A refused connection is closed with code 1008 before anything is sent, and the browser's live view holds a Vercel Function open for as long as it is watched, until the function's [maximum duration](https://vercel.com/docs/functions/limitations#max-duration); the client reconnects.

No credential reaches the model or session history.

The live view draws the stream, and falls back to the latest screenshot until one connects. Expand the screen and press **Take Over** to forward your mouse, wheel, keyboard, and paste to the device; on a Mac, Cmd is sent as Ctrl because the sandbox runs Linux. The browser's back, forward, and reload buttons travel over the same connection, and on the desktop the pointer takes the shape the desktop gives it. If the agent is working, taking over stops the turn; **Hand Back** resumes the task, and your next message tells the agent the screen may have changed.

The main pieces are:

- `agent/sandbox.ts`: the sandbox and its installs
- `agent/extensions/browser/`: the agent-browser mount, its screenshot overrides, and the disabled `close` tool
- `agent/extensions/computer/`: the computer-use mount and its `computer_use` override
- `agent/lib/screen.ts`: the wrapper that adds a screen to a tool's result
- `agent/lib/live.ts` and `agent/lib/live-relay.cjs`: the live streams, and the browser's relay in the sandbox, with tests beside them (`pnpm test`)
- `apps/web/app/api/live/`: the route that authorizes viewers, proxies the browser's stream, and issues desktop tickets
- `agent/lib/devices.ts`: the devices the picker offers, what Auto weighs for each, and the note each message carries
- `apps/web/app/api/device/`: the route that picks a device in Auto
- `apps/web/app/`: the chat, the live view with Take Over, and approvals

## Run locally

```bash
pnpm install
pnpm exec eve link
pnpm exec eve build
pnpm dev:all
```

- `eve link` connects this directory to a Vercel project in your team, and pulls AI Gateway and Vercel Sandbox credentials into `.env.local`. Sandboxes run in that project, so pick the team and project you want them billed to.
- `eve build` prepares the sandbox snapshot, which installs Chrome and the desktop and takes several minutes. Run it again after you change `agent/sandbox.ts`. Without it, the first message builds the snapshot instead, and tool calls that wait more than three minutes for it fail; send the message again once it finishes.
- `pnpm dev:all` runs the web app and the agent together on `127.0.0.1:3000`, so other machines on your network can't reach it. Open the local URL it prints.

`pnpm dev:eve` starts only the agent, with the eve terminal UI.

## Deploy

```bash
pnpm exec vercel env add EVE_COMPUTER_USE_PASSWORD
pnpm exec eve deploy
```

`eve deploy` uses the project `eve link` connected. The deployment's build prepares its own snapshot.

### Access

A deployment lets people in with one shared password, `EVE_COMPUTER_USE_PASSWORD`; pick a long one (16+ characters). Without it, the deployment lets no one in and says so. `pnpm dev:all` on your machine needs no password. The same sign-in covers the chat, the live view, and Auto: `agent/channels/eve.ts` accepts it through `passwordEveAuth`, and the app's own routes check it before they do anything (`apps/web/lib/`).

Everyone with the password shares the agent: they can read each other's chats and watch and drive their sandboxes. For per-user accounts, the [chat template](../eve-chat-template) upgrades the same pattern to Sign in with Vercel with Better Auth and a database.

Each Auto decision is a model call billed to the project. With [Upstash Redis](https://vercel.com/marketplace/upstash) connected (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` and `KV_REST_API_TOKEN`), each viewer gets 120 an hour; without it, there's no limit beyond sign-in.

## Customize

- **Approvals**: to have the agent ask before a tool runs, override the tool in its mount directory with an approval policy, for example `agent/extensions/browser/tools/evaluate.ts`:

  ```ts
  import { evaluate } from "@agent-browser/eve/tools";
  import { defineTool } from "eve/tools";
  import { always } from "eve/tools/approval";

  export default defineTool({ ...evaluate, approval: always() });
  ```

  The app shows an approval card over the screen and above the composer.

- **Allowed sites**: pass `allowedDomains` to `browser({ ... })` in `agent/extensions/browser/extension.ts`.
- **One device only**: delete the other mount directory and its entry in `agent/lib/devices.ts`.
- **Auto mode**: change `DECISION_MODEL` in `apps/web/app/api/device/route.ts` to use another [decision model](https://vercel.com/ai-gateway/models?type=evaluation), or edit each device's `criteria` in `agent/lib/devices.ts`.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```
