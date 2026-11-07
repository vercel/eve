import { runAgentBrowser } from "@agent-browser/eve/sandbox";
import type { ToolContext } from "eve/tools";

import { environment } from "../sandbox";
import { BROWSER_SESSION } from "./devices";
import { RELAY_PORT, RELAY_TOKEN_FILE, RELAY_VERSION, type LiveDevice } from "./live-config";
import { DESKTOP_STREAM_SOURCE, RELAY_SOURCE } from "./live-sources";

const DESKTOP_STREAM_PORT = 3601;
const BROWSER_STREAM_PORT = 3602;
const DESKTOP_DISPLAY = ":99";

const RELAY_PATH = "/tmp/live-relay.cjs";
const DESKTOP_STREAM_PATH = "/tmp/live-desktop.cjs";

/** A stopped sandbox resumes without its processes, so recheck the streams this often. */
const RECHECK_MS = 30_000;
const checked = new Map<string, number>();

/**
 * Start a device's live stream and the relay in front of it, and return the sandbox's name. The
 * web app's /api/live route finds the sandbox from that name in the session's own tool results,
 * then reads the relay's token from it; neither the token nor the relay's address reaches the
 * browser or the model.
 */
export async function startLive(ctx: ToolContext, device: LiveDevice): Promise<string> {
  const sandbox = await ctx.getSandbox(environment);
  const key = `${sandbox.name}:${device}`;
  if (Date.now() - (checked.get(key) ?? 0) < RECHECK_MS) return sandbox.name;

  await ensureRelay(sandbox);
  if (device === "browser") await ensureBrowserStream(ctx);
  else await ensureDesktopStream(sandbox);
  checked.set(key, Date.now());
  return sandbox.name;
}

/** The sandbox's name once its live stream runs, or nothing; the screenshot still shows the screen. */
export async function startLiveIfAvailable(
  ctx: ToolContext,
  device: LiveDevice,
): Promise<string | undefined> {
  try {
    return await startLive(ctx, device);
  } catch (error) {
    console.warn(`The ${device} live view is unavailable:`, error);
    return undefined;
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
    `setsid -f node ${RELAY_PATH} ${RELAY_PORT} ${BROWSER_STREAM_PORT} ${DESKTOP_STREAM_PORT} ${RELAY_TOKEN_FILE} ${RELAY_VERSION} ${BROWSER_SESSION} >/tmp/live-relay.log 2>&1`,
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await current()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The live view relay did not start.");
}

/** agent-browser streams each session on its own port; pin it where the relay forwards. */
async function ensureBrowserStream(ctx: ToolContext): Promise<void> {
  const status = await runAgentBrowser<{ data?: { enabled?: boolean; port?: number } }>(
    ctx,
    ["stream", "status"],
    {
      session: BROWSER_SESSION,
    },
  );
  const stream = status.json?.data;
  if (stream?.enabled && stream.port === BROWSER_STREAM_PORT) return;
  if (stream?.enabled)
    await runAgentBrowser(ctx, ["stream", "disable"], { session: BROWSER_SESSION });
  const enabled = await runAgentBrowser(
    ctx,
    ["stream", "enable", "--port", String(BROWSER_STREAM_PORT)],
    {
      session: BROWSER_SESSION,
    },
  );
  if (enabled.exitCode !== 0)
    throw new Error(`Starting the browser stream failed: ${enabled.stderr.slice(-500)}`);
}

async function ensureDesktopStream(sandbox: LiveSandbox): Promise<void> {
  const up = await sandbox.run({
    command: `curl -sf http://127.0.0.1:${DESKTOP_STREAM_PORT}/health`,
  });
  if (up.exitCode === 0) return;
  await sandbox.writeTextFile({ path: DESKTOP_STREAM_PATH, content: DESKTOP_STREAM_SOURCE });
  await start(
    sandbox,
    `setsid -f node ${DESKTOP_STREAM_PATH} ${DESKTOP_STREAM_PORT} ${DESKTOP_DISPLAY} >/tmp/live-desktop.log 2>&1`,
  );
}

async function start(sandbox: LiveSandbox, command: string): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0)
    throw new Error(`Starting the live view failed: ${result.stderr.slice(-500)}`);
}
