# Computer Use

An [eve](https://eve.dev) and Next.js app where you watch an agent operate a computer in its own sandbox. Pick a device, describe a task, and follow along in a floating window over the chat that you can drag anywhere or expand.

- **Browser**: a headless Chrome, driven with the [agent-browser](https://agent-browser.dev) extension (`@agent-browser/eve`). The agent reads the page's accessibility tree and acts on element refs.
- **Desktop**: a Linux desktop with Firefox and terminals, driven with eve's built-in computer-use extension (`eve/extensions/computer-use`). The agent sees screenshots and acts on screen coordinates.

## Architecture

```text
chat + device picker → eve agent → Vercel Sandbox (headless Chrome, Linux desktop)
                                     ↘ live stream (port 3600) → live view, Take Over
```

Both extensions run in the agent's [sandbox](https://eve.dev/docs/sandbox): each chat gets its own [Vercel Sandbox](https://vercel.com/docs/sandbox) with 4 vCPUs, during local development and when deployed. The browser and the desktop (a virtual display inside the sandbox) run side by side in it, so nothing opens on your own screen. `agent/sandbox.ts` installs agent-browser, Chrome, and the desktop into the snapshot every sandbox starts from, so sessions start warm.

The [directory mounts](https://eve.dev/docs/extensions#override-a-contribution) in `agent/extensions/` wrap each browser action and `computer_use` so its result also carries a screen for the web app: a screenshot, the page URL, and the device's live stream. `toModelOutput` keeps all three out of what the model reads. The desktop tool also passes the screenshot to the model as an image, so it can see the screen without a separate `read_file` call.

### Live view and Take Over

The first action on a device starts its live stream in the sandbox (`agent/lib/live.ts`). agent-browser streams the browser's screencast, and `agent/lib/live-sources.ts` streams the desktop with ffmpeg and takes input through xdotool. Both speak agent-browser's stream protocol: JPEG frames out, mouse and keyboard events in. A relay on the sandbox's port 3600 sits in front of them and requires a random token it writes inside the sandbox.

The browser never connects to the sandbox. It opens `/api/live?session=…&device=…` on the app's own origin, so the app's auth, Deployment Protection, Firewall rules, and rate limits apply. The route (`apps/web/app/api/live/`):

1. Reads the eve session with the caller's own credentials, over a [service binding](https://vercel.com/docs/services/bindings) to the agent (`EVE_URL` in `vercel.ts`). If eve's channel auth refuses the caller, so does the live view.
2. Takes the sandbox's name from that session's own tool results, never from the request.
3. Reads the relay's token from the sandbox with the project's credentials, connects to the relay, and passes frames out and input in.

Neither the token nor the sandbox's address reaches the browser, the model, or session history. A refused connection is closed with code 1008 before anything is sent.

The live view draws the stream, and falls back to the latest screenshot until one connects. Expand the screen and press **Take Over** to forward your mouse, wheel, keyboard, and paste to the device; on a Mac, Cmd is sent as Ctrl because the sandbox runs Linux. The browser's back, forward, and reload buttons travel over the same connection. If the agent is working, taking over stops the turn; **Hand Back** resumes the task, and your next message tells the agent the screen may have changed.

A live view holds a Vercel Function open for as long as it is watched, and closes when the function reaches its [maximum duration](https://vercel.com/docs/functions/limitations#max-duration); the client reconnects.

The main pieces are:

- `agent/sandbox.ts`: the sandbox and its installs
- `agent/extensions/browser/`: the agent-browser mount and its screenshot overrides
- `agent/extensions/computer/`: the computer-use mount and its `computer_use` override
- `agent/lib/screen.ts`: the wrapper that adds a screen to a tool's result
- `agent/lib/live.ts` and `agent/lib/live-sources.ts`: the live streams and the relay in the sandbox
- `apps/web/app/api/live/`: the WebSocket route that authorizes viewers and proxies the stream
- `agent/lib/devices.ts`: the devices the picker offers, and the note each message carries
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
- `pnpm dev:all` runs the web app and the agent together. Open the local URL it prints.

`pnpm dev:eve` starts only the agent, with the eve terminal UI.

## Deploy

```bash
pnpm exec eve deploy
```

`eve deploy` uses the project `eve link` connected. The deployment's build prepares its own snapshot.

The channel in `agent/channels/eve.ts` uses `placeholderAuth()`, which rejects browser requests in production. Replace it with your app's auth provider before you share the deployment. The live view authorizes viewers through the same channel, so whoever can read a session can watch and drive its sandbox; `none()` makes every session public.

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

## Checks

```bash
pnpm typecheck
pnpm build
```
