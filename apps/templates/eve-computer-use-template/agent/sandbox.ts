import { installAgentBrowser } from "@agent-browser/eve/sandbox";
import { installComputerUse } from "eve/extensions/computer-use/sandbox";
import { defineSandbox, type SandboxSession } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { DESKTOP_APPS } from "./lib/desktop-apps";
import { BROWSER_STREAM_PORT, DESKTOP_STREAM_PORT, RELAY_PORT } from "./lib/live-config";

/** The screen-relay release that streams the desktop to the live view; see agent/lib/live.ts. */
const SCREEN_RELAY_VERSION = "0.1.2";

// Every chat gets its own Vercel Sandbox, during development too, in the project `eve link`
// connected. The headless Chrome and the Linux desktop run in it side by side. eve installs both,
// and screen-relay for the desktop's live view, once into the snapshot every sandbox starts from;
// the tools start each on first use, so a chat only pays for the one it uses.
export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
    await installComputerUse(sandbox);
    await installDesktopApps(sandbox);
    await installScreenRelay(sandbox);
  },
  resources: { vcpus: 4 },
});

/** The desktop's other apps, from agent/lib/desktop-apps.ts; computer_use brings Firefox and xterm. */
async function installDesktopApps(sandbox: Pick<SandboxSession, "run">): Promise<void> {
  const packages = Object.values(DESKTOP_APPS)
    .map((app) => app.package)
    .join(" ");
  const result = await sandbox.run({
    command: [
      "set -e",
      'as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }',
      "as_root apt-get update",
      `as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages}`,
      "as_root apt-get clean",
      "as_root rm -rf /var/lib/apt/lists/*",
    ].join("\n"),
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Installing the desktop apps failed (exit ${result.exitCode}): ${result.stderr.slice(-1000)}`,
    );
}

/**
 * screen-relay's CLI and its engine, without a desktop of its own: it attaches to the display
 * eve's computer-use extension starts.
 */
async function installScreenRelay(sandbox: Pick<SandboxSession, "run">): Promise<void> {
  const result = await sandbox.run({
    command: [
      "set -e",
      `package=screen-relay@${SCREEN_RELAY_VERSION}`,
      'if [ "$(id -u)" = 0 ]; then npm install -g "$package";',
      'else sudo -n env "PATH=$PATH" npm install -g "$package"; fi',
      "screen-relay install --yes --backend x11 --desktop none",
    ].join("\n"),
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Installing screen-relay failed (exit ${result.exitCode}): ${result.stderr.slice(-1000)}`,
    );
}

export default defineSandbox(() =>
  environment.open({
    // The live streams: the browser's relay and screen-relay; see agent/lib/live.ts. Ports apply
    // when the sandbox is created.
    ports: [RELAY_PORT, DESKTOP_STREAM_PORT],
    env: {
      // Every agent-browser daemon streams where the relay forwards, including one that starts
      // after the last exited, instead of on a port of its own.
      AGENT_BROWSER_STREAM_PORT: String(BROWSER_STREAM_PORT),
      // agent-browser caps stream frames at 1280×720 by default, which blurs the live view.
      AGENT_BROWSER_STREAM_MAX_WIDTH: "2560",
      AGENT_BROWSER_STREAM_MAX_HEIGHT: "2560",
      AGENT_BROWSER_STREAM_QUALITY: "70",
    },
  }),
);
