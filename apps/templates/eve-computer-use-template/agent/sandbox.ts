import { installAgentBrowser } from "@agent-browser/eve/sandbox";
import { AGENT_DESKTOP_REVALIDATION_KEY, installAgentDesktop } from "@eve/agent-desktop/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { installFirefox } from "./lib/firefox";
import { BROWSER_STREAM_PORT, RELAY_PORT } from "./lib/live-config";

/**
 * The desktop's apps, which agent-desktop reads through their accessibility trees, and ffmpeg for
 * the desktop's live view. Firefox comes from `installFirefox`. Test an app before adding it:
 * xfce4-terminal crashes when agent-desktop sends it keys, and GTK3 apps that load SVG icons,
 * such as Thunar, abort because the image loaders' bubblewrap sandbox can't start here.
 */
const DESKTOP_PACKAGES = [
  "gnome-console",
  "gnome-calculator",
  "mousepad",
  "fonts-dejavu-core",
  "ffmpeg",
];

// Every chat gets its own Vercel Sandbox, during development too, in the project `eve link`
// connected. The headless Chrome and the Linux desktop run in it side by side. eve installs both
// once into the snapshot every sandbox starts from; the tools start each on first use, so a chat
// only pays for the one it uses.
export const environment = VercelSandbox.environment({
  // Rebuilds the snapshot when agent-desktop or its desktop packages change.
  env: { AGENT_DESKTOP_REVALIDATION_KEY },
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
    await installFirefox(sandbox);
    await installAgentDesktop(sandbox, { extraPackages: DESKTOP_PACKAGES });
  },
  resources: { vcpus: 4 },
});

export default defineSandbox(() =>
  environment.open({
    // The live view's relay; see agent/lib/live.ts. Ports apply when the sandbox is created.
    ports: [RELAY_PORT],
    env: {
      // Firefox only exposes its accessibility tree, which agent-desktop reads, when asked to.
      GNOME_ACCESSIBILITY: "1",
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
