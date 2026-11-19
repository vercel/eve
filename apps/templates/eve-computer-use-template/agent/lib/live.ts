import { createHash } from "node:crypto";

import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import { Sandbox } from "@vercel/sandbox";
import { startComputerUse } from "eve/extensions/computer-use/sandbox";
import type { ToolContext } from "eve/tools";

import { environment } from "../sandbox";
import { BROWSER_SESSION } from "./devices";
import {
  BROWSER_STREAM_PORT,
  DESKTOP_STREAM_PORT,
  RELAY_PORT,
  RELAY_TOKEN_FILE,
  type LiveDevice,
} from "./live-config";
import RELAY_SOURCE from "./live-relay.cjs?raw";

/** The display eve's computer-use extension draws the desktop on. */
const DESKTOP_DISPLAY = ":99";

const RELAY_PATH = "/tmp/live-relay.cjs";
/** A sandbox running a relay from other source restarts it. */
const RELAY_VERSION = createHash("sha256").update(RELAY_SOURCE).digest("hex").slice(0, 16);

/** A stopped sandbox resumes without its processes, so recheck the streams this often. */
const RECHECK_MS = 30_000;
const checked = new Map<string, number>();

/**
 * Start a device's live stream. The web app's /api/live route finds the sandbox by the session it
 * belongs to, then connects viewers to the stream; no credential reaches the model.
 */
export async function startLive(
  ctx: ToolContext,
  device: LiveDevice,
  { recheck = false }: LiveOptions = {},
): Promise<void> {
  const sandbox = await ctx.getSandbox(environment);
  const key = `${sandbox.name}:${device}`;
  if (!recheck && Date.now() - (checked.get(key) ?? 0) < RECHECK_MS) return;

  if (device === "browser") {
    await ensureRelay(sandbox);
    await ensureBrowserStream(ctx);
  } else {
    await ensureDesktopStream(sandbox);
  }
  checked.set(key, Date.now());
}

export interface LiveOptions {
  /** Check the stream now even if it was checked lately, as after the desktop changed size. */
  readonly recheck?: boolean;
}

/** Whether the device's live stream runs; without it, the screenshot still shows the screen. */
export async function startLiveIfAvailable(
  ctx: ToolContext,
  device: LiveDevice,
  options?: LiveOptions,
): Promise<boolean> {
  try {
    await startLive(ctx, device, options);
    return true;
  } catch (error) {
    console.warn(`The ${device} live view is unavailable:`, error);
    return false;
  }
}

type LiveSandbox = Awaited<ReturnType<typeof environment.open>>;

async function ensureRelay(sandbox: LiveSandbox): Promise<void> {
  const current = async () => {
    const result = await sandbox.run({
      command: `curl -sf http://127.0.0.1:${RELAY_PORT}/health >/dev/null && cat ${RELAY_TOKEN_FILE}`,
    });
    if (result.exitCode !== 0) return false;
    try {
      return (JSON.parse(result.stdout) as { version?: string }).version === RELAY_VERSION;
    } catch {
      return false;
    }
  };
  if (await current()) return;

  await sandbox.writeTextFile({ path: RELAY_PATH, content: RELAY_SOURCE });
  // An older relay holds the port. Stop it in its own command, since pkill -f also matches any
  // shell whose command line names the script; the brackets keep it from matching this one.
  await sandbox.run({
    command: `pkill -f '/tmp/live-[r]elay.cjs'; rm -f ${RELAY_TOKEN_FILE}; true`,
  });
  await start(
    sandbox,
    `setsid -f node ${RELAY_PATH} ${RELAY_PORT} ${BROWSER_STREAM_PORT} ${RELAY_TOKEN_FILE} ${RELAY_VERSION} ${BROWSER_SESSION} >/tmp/live-relay.log 2>&1`,
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await current()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The live view relay did not start.");
}

/**
 * The sandbox's env pins agent-browser's stream where the relay forwards, but a sandbox created
 * before that env, or a stream moved by hand, still needs moving there.
 */
async function ensureBrowserStream(ctx: ToolContext): Promise<void> {
  const status = await runAgentBrowser<{ data?: { enabled?: boolean; port?: number } }>(
    ctx,
    ["stream", "status"],
    { session: BROWSER_SESSION },
  );
  const stream = status.json?.data;
  if (stream?.enabled && stream.port === BROWSER_STREAM_PORT) return;
  if (stream?.enabled)
    await runAgentBrowser(ctx, ["stream", "disable"], { session: BROWSER_SESSION });
  const enabled = await runAgentBrowser(
    ctx,
    ["stream", "enable", "--port", String(BROWSER_STREAM_PORT)],
    { session: BROWSER_SESSION },
  );
  if (enabled.exitCode !== 0)
    throw new Error(`Starting the browser stream failed: ${enabled.stderr.slice(-500)}`);
}

/**
 * screen-relay attached to the computer-use display, serving its own public sandbox port behind
 * the TLS proxy Vercel Sandbox puts in front of it, as screen-relay's remote access guide
 * describes: it accepts only that host and requires its token. It stops when the display does,
 * as after the sandbox resumes, and it keeps the display's size from when it started, so a
 * session that isn't healthy, or whose size the display no longer has, is replaced. The display
 * starts here if it isn't running yet, so the live view can show it before the first action
 * finishes.
 */
async function ensureDesktopStream(sandbox: LiveSandbox): Promise<void> {
  const origin = (await Sandbox.get({ name: sandbox.name })).domain(DESKTOP_STREAM_PORT);
  const status = await sandbox.run({
    command: [
      "screen-relay status --json",
      `DISPLAY=${DESKTOP_DISPLAY} xdpyinfo 2>/dev/null | awk '/dimensions:/ { print $2; exit }'`,
    ].join("; echo; "),
  });
  const [statusJson = "", displaySize = ""] = status.stdout.split("\n").filter(Boolean);
  if (healthy(statusJson, origin, displaySize.trim())) return;
  await startComputerUse(sandbox);
  await start(
    sandbox,
    [
      "screen-relay down >/dev/null 2>&1 || true",
      `screen-relay up -d --backend x11 --display ${DESKTOP_DISPLAY} --desktop none --port ${DESKTOP_STREAM_PORT} --public ${origin}`,
    ].join("\n"),
  );
}

function healthy(statusJson: string, origin: string, displaySize: string): boolean {
  try {
    const { session } = JSON.parse(statusJson) as {
      session?: { running?: boolean; url?: string; resolution?: string; capabilities?: unknown };
    };
    return (
      session?.running === true &&
      session.capabilities !== undefined &&
      session.url === origin &&
      session.resolution === displaySize
    );
  } catch {
    return false;
  }
}

async function start(sandbox: LiveSandbox, command: string): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0)
    throw new Error(`Starting the live view failed: ${result.stderr.slice(-500)}`);
}
