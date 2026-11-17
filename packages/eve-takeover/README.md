# @eve/takeover

An [eve](https://eve.dev) extension that lets a person take over the browser or desktop your agent is using in its sandbox, do a step only they can do (sign in, enter a one-time code, solve a CAPTCHA), and hand control back. The agent never handles the secret, and nobody pastes it into chat.

> Status: experimental. Works with [`@eve/agent-browser`](../eve-agent-browser) and [`@eve/agent-desktop`](../eve-agent-desktop) on Vercel Sandbox.

## How it works

1. The agent calls `browser__takeover` (or `desktop__takeover`) with what the person should do.
2. The tool parks the turn on eve's interactive sign-in. The person who asked gets a prompt, visible only to them, that links the live viewer.
3. A small proxy in the sandbox streams the screen behind one-use tokens, on a sandbox port exposed only while the takeover is open.
4. The viewer, served by this extension, signs the person in with your app's auth and admits only the person who asked. Frames and keystrokes go straight between their browser and the sandbox.
5. Pressing **Done** (or Cancel) resumes the turn. The tool stops the proxy, unexposes the port, and tells the agent to look at the screen again.

The browser uses agent-browser's screencast. The desktop uses VNC: `x11vnc` on the agent-desktop display, bridged to the viewer's built-in VNC client.

## Install

```bash
pnpm add @eve/takeover
```

## Configure

Define the takeover once, in your app:

```ts
// agent/lib/takeover.ts
import { defineTakeover } from "@eve/takeover/core";
import { appSession } from "./auth";

export const takeover = defineTakeover({
  // At least 32 characters. Signs stream tokens and seals links; it never enters the sandbox.
  secret: process.env.TAKEOVER_SECRET!,
  // Route auth for the viewer page. It runs on a browser navigation, so accept your session cookie.
  auth: [appSession()],
});
```

Mount the viewer and pass the same value to each screen extension:

```ts
// agent/extensions/takeover.ts
import takeoverViewer from "@eve/takeover";
import { takeover } from "../lib/takeover";

export default takeoverViewer({ takeover });
```

```ts
// agent/extensions/browser.ts
import browser from "@eve/agent-browser";
import { takeover } from "../lib/takeover";

export default browser({ takeover });
```

For the desktop, also install `x11vnc` in the sandbox:

```ts
import { installAgentDesktop, TAKEOVER_APT_PACKAGES } from "@eve/agent-desktop/sandbox";

await installAgentDesktop(sandbox, { extraPackages: [...TAKEOVER_APT_PACKAGES] });
```

### Options

| Option        | Default                          | Purpose                                                                                                                                |
| ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `secret`      | required                         | Signs stream tokens and seals links.                                                                                                   |
| `auth`        | required                         | The `AuthFn` walk that signs viewers in, as on an eve channel.                                                                         |
| `isRequester` | same authenticator and principal | Whether the viewer is the person who asked. Override it when people chat in one place (Slack) and sign in to the web in another (SSO). |
| `signInUrl`   | none                             | Where to send a viewer who isn't signed in; receives the takeover path to return to.                                                   |
| `baseUrl`     | Vercel's environment             | The agent's public origin, for links.                                                                                                  |
| `ttlMs`       | 20 minutes                       | How long a takeover stays open.                                                                                                        |
| `expose`      | Vercel Sandbox port routes       | A `PortExposer` for another sandbox provider.                                                                                          |
| `port`        | 4791                             | The sandbox port the proxy listens on.                                                                                                 |

The viewer answers at `/takeover/:grant` on the agent's origin. Route that path to the agent if it sits behind a path-based router.

## Add a source

A screen extension contributes a `TakeoverSource` and calls `runTakeoverTool` from an ordinary tool:

```ts
import { runTakeoverTool, takeoverInputSchema, takeoverToolDescription } from "@eve/takeover/core";

const source = {
  label: "browser",
  protocol: "screencast", // or "rfb" for VNC
  upstream: "websocket", // or "tcp" to bridge a raw TCP server
  async prepare(sandbox) {
    return { portCommand: "echo 9222" }; // prints the stream's loopback port
  },
};
```

## Security

- Only the person who asked can open the viewer. The link is sealed, so it reveals neither the sandbox URL nor who may open it.
- Stream tokens are Ed25519-signed by your server, name one session and call, live at most two minutes, and work once. The sandbox only has the public key.
- The proxy exposes only the stream, requires your agent's origin, forwards neither Origin nor cookies, logs nothing, and exits when the takeover ends.
- Keystrokes never pass through your agent's server.

## Limitations

- The model shares the sandbox with the screen. A prompt-injected turn could plant a listener before asking for a takeover. Takeover keeps secrets out of transcripts, model context, and logs; it doesn't defend against a compromised agent. Prefer test or least-privileged accounts.
- After Done, the agent sees whatever the signed-in account shows.
- Passkeys, security keys, and device-bound SSO don't work through a stream. Password managers can't autofill the canvas, but pasting works.
- A takeover that expires without Done or Cancel leaves the port exposed, with no proxy behind it, until the next takeover.
