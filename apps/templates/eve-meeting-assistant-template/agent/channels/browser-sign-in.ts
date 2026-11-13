import { randomBytes, timingSafeEqual } from "node:crypto";

import { resolveAgentBrowserInstallSpec } from "@agent-browser/eve/sandbox";
import { defineChannel, GET } from "eve/channels";

import { sh, startBridge, type Shell } from "../lib/bridge.js";
import { BRIDGE_PORT, browserEnv, REGION, SIGN_INS_DIR, SIGN_INS_DRIVE } from "../lib/browser.js";

// `GET /meeting/browser-sign-in?token=...` opens a browser where an admin
// signs in to the service accounts eve should use, such as a Notion account
// for meeting notes, and saves them for every later meeting. It runs in its
// own long-lived sandbox, the only one that mounts the saved sign-ins
// read-write.

const SANDBOX_NAME = "meeting-browser-sign-in";
const READY = "$HOME/.agent-browser-ready";
const SETUP_LOG = "/tmp/agent-browser-setup.log";
const SETUP_PID = "/tmp/agent-browser-setup.pid";

export default defineChannel({
  routes: [
    GET("/meeting/browser-sign-in", async (request) => {
      const expected = process.env.MEETING_ADMIN_TOKEN?.trim();
      if (!expected) {
        return text(
          503,
          "Set MEETING_ADMIN_TOKEN to a long random secret, redeploy, and open this page with ?token=<secret>.",
        );
      }
      const token = new URL(request.url).searchParams.get("token") ?? "";
      if (!sameSecret(token, expected)) return text(401, "Wrong or missing ?token=.");

      const { Drive, Sandbox } = await import("@vercel/sandbox");
      const drive = await Drive.getOrCreate({ name: SIGN_INS_DRIVE, region: REGION });
      const sandbox = await Sandbox.getOrCreate({
        name: SANDBOX_NAME,
        region: REGION,
        ports: [BRIDGE_PORT],
        persistent: true,
        timeout: 30 * 60_000,
        env: browserEnv(),
        mounts: { [SIGN_INS_DIR]: { drive: drive.name, mode: "read-write" } },
      });
      const shell: Shell = async (command) => {
        const result = await sandbox.runCommand("bash", ["-lc", command]);
        return {
          exitCode: result.exitCode,
          stdout: await result.stdout(),
          stderr: await result.stderr(),
        };
      };

      // The first visit installs agent-browser and Chromium, which outlasts a
      // request, so it runs in the background and the page reloads until it's done.
      if ((await shell(`test -f ${READY}`)).exitCode !== 0) {
        const spec = resolveAgentBrowserInstallSpec();
        await sh(
          shell,
          [
            // A pid file, not `pgrep -f`, which would match this script's own command line.
            `if ! kill -0 "$(cat ${SETUP_PID} 2>/dev/null)" 2>/dev/null; then`,
            `  setsid -f bash -c 'echo $$ > ${SETUP_PID}; (npm install -g ${spec} || sudo npm install -g ${spec}) && agent-browser install --with-deps && touch ${READY}' > ${SETUP_LOG} 2>&1 < /dev/null`,
            "fi",
          ].join("\n"),
        );
        const log = await shell(`tail -n 5 ${SETUP_LOG} 2>/dev/null`);
        return html(
          `<meta http-equiv="refresh" content="10"><p>Setting up eve's browser for the first time. This takes a few minutes; this page reloads until it's ready.</p><pre></pre><script>document.querySelector("pre").textContent = ${JSON.stringify(log.stdout).replace(/</gu, "\\u003c")};</script>`,
        );
      }

      // An uninitialized Drive can't be mounted as a snapshot, so meetings
      // only see it once it has a file.
      await sh(shell, `touch ${SIGN_INS_DIR}/.initialized`);
      // A new key on every visit, so an old link stops working.
      const key = randomBytes(18).toString("hex");
      await startBridge(shell, { key, interactive: true });
      return Response.redirect(`${sandbox.domain(BRIDGE_PORT)}/${key}/sign-in`, 302);
    }),
  ],
});

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function html(body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>eve browser sign-ins</title>${body}`,
    {
      headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
    },
  );
}
