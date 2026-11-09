# @eve/agent-desktop

An [eve](https://eve.dev) extension that gives your agent a computer: desktop computer-use tools backed by [agent-desktop](https://github.com/vercel-labs/agent-desktop), running against a Linux desktop inside the agent's sandbox.

It is modeled on [`@agent-browser/eve`](https://github.com/vercel-labs/agent-browser/tree/main/packages/%40agent-browser/eve). Mount it once and the agent gets namespaced tools to launch apps, read their accessibility trees with refs, click, type, select, press keys, wait, take screenshots, and manage windows. Your sandbox's `prepare` step installs agent-desktop and a headless desktop (Xvfb, a D-Bus session, the AT-SPI accessibility bus, and openbox); the tools start the desktop when a session needs it.

> Status: prototype. Linux sandboxes only (Ubuntu 24.04 or later, such as eve's default Ubuntu image), with apt and passwordless sudo.

## Install

```bash
npm install @eve/agent-desktop
```

`eve` (1.0.0-rc.1 or later) is a peer dependency; the extension runs on the eve installed in your app.

## Prepare

Install agent-desktop, the desktop packages, and the apps the agent should operate in your sandbox environment's `prepare` callback, so every session starts from a template that already has them:

```ts
// agent/sandbox.ts
import { AGENT_DESKTOP_REVALIDATION_KEY, installAgentDesktop } from "@eve/agent-desktop/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  // eve rebuilds a template only when the sandbox file or these options change.
  // The key changes with the agent-desktop version and the desktop packages.
  env: { AGENT_DESKTOP_REVALIDATION_KEY },
  prepare: async (sandbox) => {
    await installAgentDesktop(sandbox, { extraPackages: ["gnome-calculator", "mousepad"] });
  },
});

export default defineSandbox(() => environment.open());
```

The tools never install anything at tool time. When the binary is missing or on a different agent-desktop minor, they fail with an error that points here. A prepared template keeps files, not processes, so the tools check the desktop before each command and start it when a new or resumed sandbox has none. To start it eagerly instead, call `startDesktop(sandbox)` after `environment.open()`.

`installAgentDesktop` options: `installSpec` (an npm spec for the CLI, such as a tarball or mirror; it must install this package's agent-desktop minor), `installDesktop` (`false` when the image already has a desktop session), and `extraPackages` (apt packages). It needs an apt-based image with root or passwordless sudo.

## Mount

Create a mount file under `agent/extensions/`. The file name becomes the tool namespace:

```ts
// agent/extensions/desktop.ts
import desktop from "@eve/agent-desktop";

export default desktop({});
```

The agent now has `desktop__launch`, `desktop__snapshot`, `desktop__click`, and the rest, plus an instructions fragment that teaches the observe, act, and verify loop and agent-desktop's retry rules.

## Configuration

All fields are optional:

```ts
export default desktop({
  // Input
  headed: false, // pass --headed: allow physical pointer/keyboard input and focus changes

  // Desktop
  manageDesktop: true, // start Xvfb, a session bus, and openbox when they are not running; off uses the image's own session
  display: ":100", // X display for agent-desktop and launched apps

  // Output
  inlineScreenshots: true, // data URL in the tool output for channels/UIs and pixels for the model; off keeps the sandbox path

  // CLI
  binary: "agent-desktop", // binary name or path inside the sandbox
});
```

Headless is the default, matching agent-desktop: ref actions use semantic accessibility calls and never move the pointer. Turn on `headed` only when the agent may use physical input; the pointer tools (and `scroll`, which sends wheel input on Linux) refuse without it, before doing any sandbox work.

The default display is `:100` so the extension can be mounted beside `eve/extensions/computer-use`, which runs its own desktop on `:99`.

With `inlineScreenshots` on, a capture's file is deleted once its pixels are in the tool output. A capture that cannot be inlined (over 3 MiB, or unreadable) keeps its file and its path, and the model is told why it has no pixels.

## Tools

Listed every turn: `snapshot`, `find`, `get`, `is`, `screenshot`, `click`, `right_click`, `type`, `set_value`, `clear`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll_to`, `press`, `launch`, `close_app`, `list_apps`, `list_windows`, `focus_window`, `wait`.

Deferred (found with `eve__search`): `scroll`, `focus`, `double_click`, `triple_click`, `hover`, `drag`, `mouse_click`, `mouse_move`, `mouse_wheel`, `resize_window`, `move_window`, `minimize`, `maximize`, `restore`, `list_surfaces`, `list_displays`, `clipboard_get`, `clipboard_set`, `clipboard_clear`, `status`.

Every coordinate input is one `"x,y"` string.

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

Each tool runs one `agent-desktop <command>` in the sandbox from `ctx.getSandbox()`, inside the managed desktop session (`DISPLAY`, the session bus, and the accessibility variables), and returns the `data` of its JSON envelope. An error envelope becomes a tool error that keeps agent-desktop's `code`, `suggestion`, and `disposition.retry`, so the model only retries when the CLI says retrying is safe. Each call has a five-minute budget covering the version probe, desktop start, the command, and screenshot readback. Cancellation attempts to kill the command before reporting failure. The error states whether termination was confirmed and tells the model to read the live state before acting again.

Each sandbox command has an 8 MiB combined stdout/stderr limit, including version probes, installation, and desktop startup. If output exceeds that limit, the runner cancels both readers and attempts to stop the command before returning a bounded error. The error preserves delivery uncertainty and tells the model to inspect live state before retrying.

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

Tests live in `test/integration/` and `test/scenario/`; see [AGENTS.md](https://github.com/vercel/eve/tree/main/packages/eve-agent-desktop/AGENTS.md). The last two commands are opt-in locally. On pull requests that touch this package, CI checks each tool's argv against the targeted CLI version and drives gnome-calculator on Ubuntu. The live check needs Ubuntu 24.04 or later and root or passwordless sudo; it installs desktop packages.

## License

Apache-2.0
