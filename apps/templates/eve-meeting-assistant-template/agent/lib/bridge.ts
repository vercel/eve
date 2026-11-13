import { BRIDGE_PORT, BROWSER_SESSION, STATE_FILE, STREAM_PORT } from "./browser.js";
import { BRIDGE_SERVER, SCREEN_HTML, SIGN_IN_HTML } from "./stage-assets.js";

/** Runs a shell command in a sandbox. Meeting sandboxes and the sign-in sandbox each provide one. */
export type Shell = (
  command: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const ROOT = "/tmp/eve-bridge";

export async function sh(shell: Shell, command: string): Promise<string> {
  const result = await shell(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
    );
  }
  return result.stdout;
}

/** agent-browser loads the saved sign-ins when its browser starts, once someone saved them. */
export const LOAD_SIGN_INS = `test -f ${STATE_FILE} && mkdir -p ~/.agent-browser && printf '{"state":"${STATE_FILE}"}' > ~/.agent-browser/config.json || true`;

/**
 * Starts the bridge and the browser, or updates the bridge's files and key
 * when they already run. A resumed sandbox keeps files but not processes, so
 * this checks every time.
 */
export async function startBridge(
  shell: Shell,
  options: { readonly key: string; readonly interactive: boolean },
): Promise<void> {
  const files: Record<string, string> = {
    "bridge.mjs": BRIDGE_SERVER,
    "screen.html": SCREEN_HTML,
    "sign-in.html": SIGN_IN_HTML,
    key: options.key,
  };
  const env = [
    `BRIDGE_ROOT=${ROOT}`,
    `BRIDGE_PORT=${BRIDGE_PORT}`,
    `BRIDGE_SESSION=${BROWSER_SESSION}`,
    `BRIDGE_STATE_FILE=${STATE_FILE}`,
    `BRIDGE_INTERACTIVE=${options.interactive ? 1 : 0}`,
    `AGENT_BROWSER_STREAM_PORT=${STREAM_PORT}`,
  ].join(" ");
  await sh(
    shell,
    [
      `mkdir -p ${ROOT}`,
      ...Object.entries(files).map(
        ([name, content]) =>
          `printf %s '${Buffer.from(content).toString("base64")}' | base64 -d > ${ROOT}/${name}`,
      ),
      LOAD_SIGN_INS,
      // The stream only runs while the browser does.
      `agent-browser --session ${BROWSER_SESSION} get url >/dev/null 2>&1 || agent-browser --session ${BROWSER_SESSION} open about:blank >/dev/null`,
      `if ! curl -fs http://127.0.0.1:${BRIDGE_PORT}/healthz >/dev/null; then`,
      `  ${env} setsid -f node ${ROOT}/bridge.mjs > ${ROOT}/bridge.log 2>&1 < /dev/null`,
      "fi",
      "for _ in $(seq 1 50); do",
      `  curl -fs http://127.0.0.1:${BRIDGE_PORT}/healthz >/dev/null && exit 0`,
      "  sleep 0.1",
      "done",
      `cat ${ROOT}/bridge.log >&2; exit 1`,
    ].join("\n"),
  );
}
