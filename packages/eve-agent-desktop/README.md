# @eve/agent-desktop

An [eve](https://eve.dev) extension that gives your agent a computer: desktop computer-use tools backed by [agent-desktop](https://github.com/vercel-labs/agent-desktop), running against a Linux desktop inside the agent's sandbox.

It is modeled on [`@agent-browser/eve`](https://github.com/vercel-labs/agent-browser/tree/main/packages/%40agent-browser/eve). Mount it once and the agent gets namespaced tools to launch apps, read their accessibility trees with refs, click, type, select, press keys, wait, take screenshots, and manage windows. On first use in a fresh sandbox, the extension installs agent-desktop and a headless desktop (Xvfb, a D-Bus session, the AT-SPI accessibility bus, and openbox), then starts it.

> Status: prototype. Linux sandboxes only (Ubuntu 24.04 or later, such as eve's default Ubuntu image), with apt and passwordless sudo.

## Install

```bash
npm install @eve/agent-desktop
```

`eve` (1.0.0-rc.1 or later) is a peer dependency; the extension runs on the eve installed in your app.

## Mount

Create a mount file under `agent/extensions/`. The file name becomes the tool namespace:

```ts
// agent/extensions/desktop.ts
import desktop from "@eve/agent-desktop";

export default desktop({
  extraPackages: ["gnome-calculator", "mousepad"], // apps the agent should operate
});
```

The agent now has `desktop__launch`, `desktop__snapshot`, `desktop__click`, and the rest, plus an instructions fragment that teaches the observe, act, and verify loop and agent-desktop's retry rules.

For production, install in your sandbox's `prepare` step so sessions start from a warm template, and start the desktop when a session opens:

```ts
// agent/sandbox.ts
import { installAgentDesktop, startDesktop } from "@eve/agent-desktop/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installAgentDesktop(sandbox, { extraPackages: ["gnome-calculator"] });
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await startDesktop(sandbox);
  return sandbox;
});
```

A prepared template keeps files, not processes. The tools check the desktop before each command and start it again when a resumed sandbox lost it.

## Configuration

All fields are optional:

```ts
export default desktop({
  // Input
  headed: false, // pass --headed: allow physical pointer/keyboard input and focus changes

  // Desktop
  manageDesktop: true, // start Xvfb, a session bus, and openbox when they are not running; off uses the image's own session
  display: ":99", // X display for agent-desktop and launched apps

  // Output
  inlineScreenshots: true, // data URL in the tool output for channels/UIs and pixels for the model; off keeps the sandbox path

  // Install
  autoInstall: true, // install on first use, or replace a different agent-desktop minor
  installSpec: undefined, // npm spec; must install this package's agent-desktop minor
  installDesktop: true, // apt-install the desktop packages
  extraPackages: [], // extra apt packages, such as the apps to operate
  binary: "agent-desktop", // a custom binary or path is used as is and never auto-installed
});
```

Headless is the default, matching agent-desktop: ref actions use semantic accessibility calls and never move the pointer. Turn on `headed` only when the agent may use physical input; the pointer tools refuse without it.

With `inlineScreenshots` on, a capture's file is deleted once its pixels are in the tool output. A capture that cannot be inlined (over 3 MiB, or unreadable) keeps its file and its path, and the model is told why it has no pixels.

## Tools

Listed every turn: `snapshot`, `find`, `get`, `is`, `screenshot`, `click`, `right_click`, `type`, `set_value`, `clear`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll`, `scroll_to`, `press`, `launch`, `close_app`, `list_apps`, `list_windows`, `focus_window`, `wait`.

Deferred (found with `eve__search`): `focus`, `double_click`, `triple_click`, `hover`, `drag`, `mouse_click`, `mouse_move`, `mouse_wheel`, `resize_window`, `move_window`, `minimize`, `maximize`, `restore`, `list_surfaces`, `list_displays`, `clipboard_get`, `clipboard_set`, `clipboard_clear`, `status`.

Notifications, sessions, tracing, cursor overlays, and `batch` are not exposed yet.

## Overrides

Standard eve extension overrides apply. For example, require approval before quitting apps:

```ts
// agent/extensions/desktop/tools/close_app.ts
import { close_app } from "@eve/agent-desktop/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({ ...close_app, approval: always() });
```

## How it works

Each tool runs one `agent-desktop <command>` in the sandbox from `ctx.getSandbox()`, inside the managed desktop session (`DISPLAY`, the session bus, and the accessibility variables), and returns the `data` of its JSON envelope. An error envelope becomes a tool error that keeps agent-desktop's `code`, `suggestion`, and `disposition.retry`, so the model only retries when the CLI says retrying is safe. Each call has a five-minute budget covering install, desktop start, the command, and screenshot readback. Cancellation attempts to kill the command before reporting failure. The error states whether termination was confirmed and tells the model to read the live state before acting again.

Each sandbox command has an 8 MiB combined stdout/stderr limit, including version probes, installation, and desktop startup. If output exceeds that limit, the runner cancels both readers and attempts to stop the command before returning a bounded error. The error preserves delivery uncertainty and tells the model to inspect live state before retrying.

A sandbox running a different agent-desktop minor is reinstalled, or reported with an install hint. A failed install is not retried for five minutes in that session.

## Develop

Run these commands from the `vercel/eve` repository root:

```bash
pnpm install
pnpm exec turbo run build --filter=@eve/agent-desktop
pnpm --filter @eve/agent-desktop test
pnpm --filter @eve/agent-desktop typecheck
AGENT_DESKTOP_BIN=/path/to/agent-desktop pnpm --filter @eve/agent-desktop test:conformance
AGENT_DESKTOP_LIVE=1 pnpm --filter @eve/agent-desktop test:live
```

The last two commands are opt-in locally. CI checks each tool's argv against the targeted CLI version and drives gnome-calculator on Ubuntu. The live check needs Ubuntu 24.04 or later and root or passwordless sudo; it installs desktop packages.

## License

Apache-2.0
