import { startComputerUse } from "eve/extensions/computer-use/sandbox";
import { computer_use } from "eve/extensions/computer-use/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { DESKTOP_APP_NAMES, DESKTOP_APPS } from "../../../lib/desktop-apps";
import { startLiveIfAvailable } from "../../../lib/live";
import { captureDesktop, desktopModelOutput, type DeviceOutput } from "../../../lib/screen";

/** How long to wait for the app's window to appear. */
const WINDOW_TIMEOUT_SECONDS = 15;

/**
 * Open a desktop app that computer_use can't launch itself, then return a screenshot like
 * computer_use does, so the agent works the app with computer_use from there.
 */
export default defineTool<
  { app: (typeof DESKTOP_APP_NAMES)[number] },
  DeviceOutput & Record<string, unknown>
>({
  description: `Open an app on the Linux desktop: ${DESKTOP_APP_NAMES.map((name) => `\`${name}\` (${DESKTOP_APPS[name].label})`).join(", ")}. Firefox and the terminal open with computer_use's \`launch\` action instead. Returns a screenshot; operate the app with computer_use.`,
  inputSchema: z.object({ app: z.enum(DESKTOP_APP_NAMES) }),
  label: {
    start: ({ app }) => `Open ${DESKTOP_APPS[app].label.toLowerCase()}`,
  },
  async *execute({ app }, ctx) {
    const early = await startLiveIfAvailable(ctx, "desktop");
    if (early !== undefined) yield { live: { device: "desktop", sandbox: early } };

    const sandbox = await ctx.getSandbox();
    await startComputerUse(sandbox);
    const { command, windowClass } = DESKTOP_APPS[app];
    const opened = await sandbox.run({
      command: [
        `if ! DISPLAY=:99 xdotool search --onlyvisible --class ${windowClass} >/dev/null 2>&1; then`,
        `  setsid -f env DISPLAY=:99 GSK_RENDERER=cairo ${command} >/tmp/desktop-app-${app}.log 2>&1`,
        "fi",
        `for _ in $(seq 1 ${WINDOW_TIMEOUT_SECONDS * 10}); do`,
        `  window=$(DISPLAY=:99 xdotool search --onlyvisible --class ${windowClass} | head -n 1)`,
        '  if [ -n "$window" ]; then DISPLAY=:99 xdotool windowactivate "$window"; exit 0; fi',
        "  sleep 0.1",
        "done",
        `tail -n 40 /tmp/desktop-app-${app}.log >&2`,
        "exit 1",
      ].join("\n"),
      signal: ctx.abortSignal,
    });
    if (opened.exitCode !== 0)
      throw new Error(
        `${DESKTOP_APPS[app].label} did not open within ${WINDOW_TIMEOUT_SECONDS}s: ${opened.stderr.slice(-500)}`,
      );

    const shot = (await computer_use.execute({ request: { action: "screenshot" } }, ctx)) as {
      readonly screenshot: string;
    } & Record<string, unknown>;
    const liveSandbox = early ?? (await startLiveIfAvailable(ctx, "desktop"));
    yield {
      opened: app,
      ...shot,
      screen: await captureDesktop(ctx, shot.screenshot, liveSandbox),
    };
  },
  toModelOutput: desktopModelOutput,
});
