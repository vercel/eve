import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    /** Binary name or path inside the sandbox. Install it in the sandbox environment's `prepare` with `installAgentDesktop`. */
    binary: z.string().default("agent-desktop"),
    /**
     * Start the managed Xvfb display, session bus and window manager before a command when they are not running.
     * Turn off when the sandbox image already runs its own desktop session; set `display` to match it.
     */
    manageDesktop: z.boolean().default(true),
    /** X display agent-desktop and launched apps use. Not `:99`, which `eve/extensions/computer-use` uses. */
    display: z.string().default(":100"),
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
