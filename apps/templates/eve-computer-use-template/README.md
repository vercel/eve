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

The first action on a device starts its live stream in the sandbox (`agent/lib/live.ts`). agent-browser streams the browser's screencast as JPEG frames. [screen-relay](https://github.com/vercel-labs/screen-relay) attaches to the desktop's display and streams it as H.264, which the live view decodes with WebCodecs (`apps/web/app/screen-relay.ts`); watching the desktop needs a browser with H.264 WebCodecs, such as current Chrome, Edge, or Safari. A relay on the sandbox's port 3600 (`agent/lib/live-sources.ts`) sits in front of both and requires a random token it writes inside the sandbox. screen-relay listens on `127.0.0.2`, so it requires a token of its own, which only the relay reads; a web page open in the sandbox's browsers can reach neither stream.

The browser never connects to the sandbox. It opens `/api/live?session=…&device=…` on the app's own origin, so the app's auth, Deployment Protection, Firewall rules, and rate limits apply. The route (`apps/web/app/api/live/`):

1. Refuses a connection from another site's page, by its `Origin`.
2. Reads the eve session with the caller's own credentials, over a [service binding](https://vercel.com/docs/services/bindings) to the agent (`EVE_URL` in `vercel.ts`). If eve's channel auth refuses the caller, so does the live view.
3. Takes the sandbox's name from the results of that session's own browser or desktop tools, never from the request or any other tool, and checks that the sandbox carries the `sessionId` tag eve gives each session's sandbox. Code in the sandbox can shape those results, but can't point the route at another session's sandbox. It reads back from the session's latest events, so a long session isn't replayed each time a viewer connects.
4. Reads the relay's token from the sandbox with the project's credentials, connects to the relay, and passes frames out and input in.

Neither the token nor the sandbox's address reaches the browser, the model, or session history. A refused connection is closed with code 1008 before anything is sent.

The live view draws the stream, and falls back to the latest screenshot until one connects. Expand the screen and press **Take Over** to forward your mouse, wheel, keyboard, and paste to the device; on a Mac, Cmd is sent as Ctrl because the sandbox runs Linux. The browser's back, forward, and reload buttons travel over the same connection. If the agent is working, taking over stops the turn; **Hand Back** resumes the task, and your next message tells the agent the screen may have changed.

A live view holds a Vercel Function open for as long as it is watched, and closes when the function reaches its [maximum duration](https://vercel.com/docs/functions/limitations#max-duration); the client reconnects.

The main pieces are:

- `agent/sandbox.ts`: the sandbox and its installs
- `agent/extensions/browser/`: the agent-browser mount, its screenshot overrides, and the disabled `close` tool
- `agent/extensions/computer/`: the computer-use mount and its `computer_use` override
- `agent/lib/screen.ts`: the wrapper that adds a screen to a tool's result
- `agent/lib/live.ts` and `agent/lib/live-sources.ts`: the live streams and the relay in the sandbox
- `apps/web/app/api/live/`: the WebSocket route that authorizes viewers and proxies the stream
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
pnpm exec eve deploy
```

`eve deploy` uses the project `eve link` connected. The deployment's build prepares its own snapshot.

The channel in `agent/channels/eve.ts` uses `placeholderAuth()`, which rejects browser requests in production. Replace it with your app's auth provider before you share the deployment. The live view authorizes viewers through the same channel, so whoever can read a session can watch and drive its sandbox; `none()` makes every session public. Auto's `/api/device` route doesn't read a session, so `authorize()` in `apps/web/app/api/caller.ts` stands in for it the same way: it refuses production requests until you replace it with the same provider.

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
pnpm build
```
