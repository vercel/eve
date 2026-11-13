import { randomBytes } from "node:crypto";

import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import { callRecallApi } from "@eve/recall";
import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";

import { environment } from "../sandbox.js";
import { startBridge, type Shell } from "./bridge.js";
import { BRIDGE_PORT, BROWSER_SESSION } from "./browser.js";
import { toPageId } from "./notion.js";

// The meeting bot shares one page as its screen through Recall Output Media:
// the bridge in the session's sandbox, which shows eve's browser. Docs open in
// that browser, signed in with the accounts an admin saved.

type Ctx = Pick<ToolContext, "getSandbox">;

/** The bridge's public URL. Its path is unguessable: the sandbox's public port has no other auth. */
const stage = defineState<string | null>("meetings.stage", () => null);

/** The page eve opened on screen, and whether the view follows eve's edits there. */
const shownPage = defineState<{ pageId: string; url: string; follow: boolean } | null>(
  "meetings.shown-page",
  () => null,
);

/** What the bot is sharing, or `null` when it isn't. */
const sharing = defineState<{ botId: string; url: string } | null>("meetings.sharing", () => null);

/**
 * Starts the bridge in the session's sandbox and returns the URL that shows
 * the browser, and whether the bridge is new, so a share must reload it.
 */
export async function startStage(ctx: Ctx): Promise<{ url: string; restarted: boolean }> {
  const sandbox = await ctx.getSandbox(environment);
  let url = stage.get();
  if (url === null) {
    const { Sandbox } = await import("@vercel/sandbox");
    const live = await Sandbox.get({ name: sandbox.name });
    url = `${live.domain(BRIDGE_PORT)}/${randomBytes(18).toString("hex")}/`;
    stage.update(() => url);
  }
  const shell: Shell = async (command) => await sandbox.run({ command });
  const restarted = await startBridge(shell, {
    key: new URL(url).pathname.split("/")[1]!,
    interactive: false,
  });
  return { url, restarted };
}

export async function openInBrowser(ctx: Ctx, url: string): Promise<void> {
  await runAgentBrowser(ctx, ["open", url], { session: BROWSER_SESSION });
}

/**
 * What the browser shows: its title and the start of its text, so the model
 * notices a sign-in or no-access screen instead of sharing it.
 */
export async function describePage(ctx: Ctx): Promise<{ title: string; text: string }> {
  const read = async (args: string[]) => {
    try {
      const { stdout } = await runAgentBrowser(ctx, args, {
        json: false,
        session: BROWSER_SESSION,
      });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  // Apps such as Notion never go network-idle, so give the page a moment instead.
  await read(["wait", "2000"]);
  const [title, text] = [await read(["get", "title"]), await read(["get", "text", "body"])];
  return { title, text: text.replace(/\s+/gu, " ").slice(0, 400) };
}

export function setShownPage(page: { pageId: string; url: string; follow: boolean } | null): void {
  shownPage.update(() => page);
}

/**
 * Scrolls the page on screen to a block eve just edited, unless people asked
 * the view to stay put. Navigating to the block's anchor makes Notion scroll
 * to it and flash it.
 */
export async function followEdit(
  ctx: Ctx,
  pageId: string,
  blockId: string | undefined,
): Promise<void> {
  const shown = shownPage.get();
  if (!shown?.follow || blockId === undefined || shown.pageId !== pageId) return;
  await openInBrowser(ctx, `${shown.url.replace(/#.*$/u, "")}#${toPageId(blockId)}`);
}

function outputMedia(botId: string) {
  return `/bot/${encodeURIComponent(botId)}/output_media/`;
}

/** Shares `url` as the bot's screen. The camera keeps showing the voice page. */
export async function shareScreen(botId: string, url: string, reload = false): Promise<void> {
  const current = sharing.get();
  if (!reload && current?.botId === botId && current.url === url) return;
  if (current?.botId === botId) await stopScreenShare();
  // `@eve/recall`'s startOutputMedia uses the camera, which the voice page holds.
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
