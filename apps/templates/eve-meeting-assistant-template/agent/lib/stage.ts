import { randomBytes } from "node:crypto";

import { callRecallApi } from "@eve/recall";
import { defineState } from "eve/context";
import { startComputerUse } from "eve/extensions/computer-use/sandbox";
import type { ToolContext } from "eve/tools";

import { environment, STAGE_PORT } from "../sandbox.js";
import { toPageId } from "./notion.js";
import { STAGE_HTML, STAGE_SERVER } from "./stage-assets.js";

// The meeting bot shares one web page as its screen through Recall Output
// Media: the desktop stage, a page served from the session's sandbox that
// streams its screen. Notion pages open in the desktop's Firefox, because
// Notion turns away the browser Recall shares pages from.

const STAGE_ROOT = "/tmp/eve-stage";
const DISPLAY = ":99";
const FFMPEG_PID = `${STAGE_ROOT}/ffmpeg.pid`;

/** The desktop stage's URL. Its path is unguessable: the sandbox's public port has no other auth. */
const desktopStage = defineState<string | null>("meetings.desktop-stage", () => null);

/**
 * The Notion page open on the desktop for the meeting, and whether the view
 * follows eve's edits there.
 */
const shownPage = defineState<{ pageId: string; url: string; follow: boolean } | null>(
  "meetings.shown-page",
  () => null,
);

/** What the bot is sharing, or `null` when it isn't. */
const sharing = defineState<{ botId: string; url: string } | null>("meetings.sharing", () => null);

type Sandbox = Awaited<ReturnType<typeof openSandbox>>;

async function openSandbox(ctx: Pick<ToolContext, "getSandbox">) {
  return await ctx.getSandbox(environment);
}

async function run(sandbox: Sandbox, command: string): Promise<string> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    throw new Error(`Stage command failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`);
  }
  return result.stdout;
}

/** Starts the desktop stream and the page that shows it, and returns the page's public URL. */
export async function startDesktopStage(ctx: Pick<ToolContext, "getSandbox">): Promise<string> {
  const sandbox = await openSandbox(ctx);
  let url = desktopStage.get();
  if (url === null) {
    const { Sandbox } = await import("@vercel/sandbox");
    const live = await Sandbox.get({ name: sandbox.name });
    url = `${live.domain(STAGE_PORT)}/${randomBytes(18).toString("hex")}/`;
    desktopStage.update(() => url);
  }
  const dir = `${STAGE_ROOT}/${new URL(url).pathname.split("/")[1]}`;
  await run(sandbox, `mkdir -p ${dir}`);
  await sandbox.writeTextFile({ path: `${STAGE_ROOT}/server.mjs`, content: STAGE_SERVER });
  await sandbox.writeTextFile({ path: `${dir}/index.html`, content: STAGE_HTML });
  const ready = await sandbox.run({ command: `xdpyinfo -display ${DISPLAY} >/dev/null 2>&1` });
  if (ready.exitCode !== 0) await startComputerUse(sandbox);
  // A resumed sandbox keeps files but not processes, so check every time.
  // The share is 1280x720, so a desktop that size keeps text readable. It can
  // only shrink before any window opens; after that, frames are scaled down.
  // A few frames a second is enough to follow a browser.
  await run(
    sandbox,
    [
      `export DISPLAY=${DISPLAY}`,
      "xdotool search --onlyvisible --class firefox-esr >/dev/null 2>&1 || xrandr --fb 1280x720 >/dev/null 2>&1 || true",
      "size=$(xdpyinfo | awk '/dimensions:/ {print $2}')",
      // A pid file, not `pgrep -f`, which would match this script's own command line.
      `if ! kill -0 "$(cat ${FFMPEG_PID} 2>/dev/null)" 2>/dev/null; then`,
      `  setsid -f sh -c 'echo $$ > ${FFMPEG_PID}; exec ffmpeg -loglevel error -f x11grab -framerate 4 -video_size '"$size"' -i ${DISPLAY} -vf scale=1280:720 -q:v 3 -update 1 -y ${dir}/screen.jpg' > ${STAGE_ROOT}/ffmpeg.log 2>&1 < /dev/null`,
      "fi",
      `if ! curl -fs http://127.0.0.1:${STAGE_PORT}/healthz >/dev/null; then`,
      `  STAGE_ROOT=${STAGE_ROOT} STAGE_PORT=${STAGE_PORT} setsid -f node ${STAGE_ROOT}/server.mjs > ${STAGE_ROOT}/server.log 2>&1`,
      "fi",
      "for _ in $(seq 1 50); do",
      `  curl -fs http://127.0.0.1:${STAGE_PORT}/healthz >/dev/null && exit 0`,
      "  sleep 0.1",
      "done",
      `cat ${STAGE_ROOT}/server.log >&2; exit 1`,
    ].join("\n"),
  );
  return url;
}

export function setShownPage(page: { pageId: string; url: string; follow: boolean } | null): void {
  shownPage.update(() => page);
}

/**
 * Scrolls the page on screen to a block eve just edited, unless people asked
 * the view to stay put.
 */
export async function followEdit(
  ctx: Pick<ToolContext, "getSandbox">,
  pageId: string,
  blockId: string | undefined,
): Promise<void> {
  const shown = shownPage.get();
  if (!shown?.follow || blockId === undefined || shown.pageId !== pageId) return;
  await scrollShownPage(ctx, { block: blockId });
}

/**
 * Scrolls the Notion page on screen: to a block, by navigating to its anchor,
 * which makes Notion scroll to it and flash it, or by a screen or to an end,
 * with the mouse wheel over the page.
 */
export async function scrollShownPage(
  ctx: Pick<ToolContext, "getSandbox">,
  to: { readonly block: string } | "up" | "down" | "top" | "bottom",
): Promise<void> {
  const shown = shownPage.get();
  if (shown === null)
    throw new Error("No Notion page is on screen. Show one with `present` first.");
  const focus = [
    `export DISPLAY=${DISPLAY}`,
    "window=$(xdotool search --onlyvisible --class firefox-esr | head -n 1)",
    '[ -n "$window" ] || { echo "Firefox isn\'t open" >&2; exit 1; }',
    'xdotool windowactivate --sync "$window"',
  ];
  let steps: string[];
  if (typeof to === "object") {
    const url = `${shown.url.replace(/#.*$/u, "")}#${toPageId(to.block)}`;
    if (!/^https:\/\/[^\s']+$/u.test(url)) throw new Error("The page's link can't be scrolled to.");
    steps = [
      "xdotool key --clearmodifiers ctrl+l",
      `xdotool type --clearmodifiers --delay 1 '${url}'`,
      "xdotool key --clearmodifiers Return",
    ];
  } else {
    // Wheel clicks over the middle of the page, where Notion's scroll area is:
    // about one screen for up and down, and plenty for the ends.
    const clicks = to === "up" || to === "down" ? 8 : 200;
    const button = to === "up" || to === "top" ? 4 : 5;
    steps = [
      'eval "$(xdotool getwindowgeometry --shell "$window")"',
      'xdotool mousemove --window "$window" $((WIDTH / 2)) $((HEIGHT / 2))',
      `xdotool click --repeat ${clicks} --delay 15 ${button}`,
    ];
  }
  await run(await openSandbox(ctx), [...focus, ...steps].join("\n"));
}

/** Stops streaming the desktop, when it was started. */
export async function stopDesktopStage(ctx: Pick<ToolContext, "getSandbox">): Promise<void> {
  if (desktopStage.get() === null) return;
  await run(await openSandbox(ctx), `kill "$(cat ${FFMPEG_PID} 2>/dev/null)" 2>/dev/null || true`);
}

function outputMedia(botId: string) {
  return `/bot/${encodeURIComponent(botId)}/output_media/`;
}

/** Shares `url` as the bot's screen, replacing what it shared before. */
export async function shareScreen(botId: string, url: string): Promise<void> {
  const current = sharing.get();
  if (current?.botId === botId && current.url === url) return;
  if (current?.botId === botId) await stopScreenShare();
  // `@eve/recall`'s startOutputMedia uses the camera; a screen share reads better for docs.
  await callRecallApi({
    path: outputMedia(botId),
    body: { screenshare: { kind: "webpage", config: { url } } },
  });
  sharing.update(() => ({ botId, url }));
}

export async function stopScreenShare(): Promise<void> {
  shownPage.update(() => null);
  const current = sharing.get();
  if (current === null) return;
  await callRecallApi({
    path: outputMedia(current.botId),
    method: "DELETE",
    body: { screenshare: true },
  });
  sharing.update(() => null);
}
