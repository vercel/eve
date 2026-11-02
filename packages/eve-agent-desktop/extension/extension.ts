import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    /** Install agent-desktop (and the desktop packages) into the sandbox on first tool use when missing. */
    autoInstall: z.boolean().default(true),
    /** Binary name or path inside the sandbox. */
    binary: z.string().default("agent-desktop"),
    /** npm spec for auto-install. Must install this package's agent-desktop minor. Defaults to the matching version. */
    installSpec: z.string().optional(),
    /** Install the Xvfb desktop packages during auto-install. */
    installDesktop: z.boolean().default(true),
    /** Extra apt packages to install during auto-install, such as the apps the agent should operate. */
    extraPackages: z.array(z.string()).default([]),
    /**
     * Start the managed Xvfb display, session bus and window manager before a command when they are not running.
     * Turn off when the sandbox image already runs its own desktop session; set `display` to match it.
     */
    manageDesktop: z.boolean().default(true),
    /** X display agent-desktop and launched apps use. */
    display: z.string().default(":99"),
    /**
     * Pass agent-desktop's global `--headed` flag, which allows physical pointer and keyboard input and focus changes.
     * Off by default: ref actions then use semantic accessibility calls only, and the pointer tools refuse.
     */
    headed: z.boolean().default(false),
    /**
     * Embed captured screenshots in the tool output as data URLs, so channels/UIs can render them inline and the
     * model sees the pixels. When off, the output carries only the sandbox path.
     */
    inlineScreenshots: z.boolean().default(true),
  }),
});
