import { defaultBackend, defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Sandbox lifecycle fixture exercising the surfaces an agent author relies
 * on. The matching evals live under `evals/sandbox/` and assert each piece
 * end-to-end through a real backend.
 *
 * - `bootstrap` runs once per sandbox template. It writes a known marker
 *   file into the workspace AND installs a custom CLI (`eve-greet`) onto the
 *   PATH, the way an author would provision tooling every later session
 *   inherits. The CLI is a Python script, so it also proves the base image's
 *   real Python runtime executes bootstrap-authored code.
 * - `onSession` runs once per live session. It writes a per-session marker
 *   so an eval can prove session-scoped setup ran on top of the shared
 *   template.
 *
 * Backend is left as the framework default so this fixture works both
 * locally (where `defaultBackend()` resolves to `docker()`) and on Vercel
 * deployments (where it resolves to `vercel()`). Both run the published
 * `ghcr.io/vercel/eve:latest` base image, which ships Python, Node, and git;
 * the bootstrap below assumes that real-binary environment and is not meant
 * to run against the dependency-free `just-bash` fallback.
 *
 * `EVE_TEST_AUTHOR_SNAPSHOT_ID`, when set, overrides the backend with
 * `vercel({ source: { type: "snapshot", snapshotId } })` so the
 * sandbox-author-snapshot smoke test can verify that an author-supplied
 * snapshot is honored as the template base layer while bootstrap still
 * runs on top.
 */
export const SANDBOX_MARKER_PATH = "/workspace/smoke-marker.txt";
export const SANDBOX_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";

/**
 * Custom CLI installed during bootstrap. `/usr/local/bin` is on the default
 * PATH in the base image and is writable by the sandbox user (it is the npm
 * global prefix bin, chowned to `vercel-sandbox`), so the same install works
 * whether bootstrap runs as root (Docker) or as `vercel-sandbox` (Vercel).
 */
export const SANDBOX_CLI_PATH = "/usr/local/bin/eve-greet";
export const SANDBOX_CLI_TOKEN = "eve-greet-cli-ok-R7M";

/** Per-session marker written by `onSession` (live session, not the template). */
export const SANDBOX_SESSION_MARKER_PATH = "/workspace/session-marker.txt";
export const SANDBOX_SESSION_MARKER_TOKEN = "sandbox-onsession-ok-X5T";

const FANOUT_SERVER_PORT = 43_100;
const FANOUT_SERVER_PATH = "/workspace/eve-fanout-server.py";
const FANOUT_SERVER_LOG_PATH = "/workspace/eve-fanout-server.log";
const FANOUT_BARRIER_SIZE = 10;
const FANOUT_BARRIER_TIMEOUT_SECONDS = 15;

const CLI_SCRIPT = [
  "#!/usr/bin/env python3",
  "import sys",
  'name = sys.argv[1] if len(sys.argv) > 1 else "world"',
  `print(f"${SANDBOX_CLI_TOKEN}:{name}")`,
  "",
].join("\n");

const FANOUT_SERVER_SCRIPT = [
  "import json",
  "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
  "from threading import Condition",
  "from time import monotonic",
  "from urllib.parse import parse_qs, urlparse",
  "",
  `BARRIER_SIZE = ${FANOUT_BARRIER_SIZE}`,
  `BARRIER_TIMEOUT_SECONDS = ${FANOUT_BARRIER_TIMEOUT_SECONDS}`,
  "barrier = Condition()",
  "arrived = 0",
  "released_count = None",
  "",
  "class Handler(BaseHTTPRequestHandler):",
  "    def do_GET(self):",
  "        parsed = urlparse(self.path)",
  "        if parsed.path == '/health':",
  "            self.respond(200, {'ok': True})",
  "            return",
  "        if parsed.path != '/barrier':",
  "            self.respond(404, {'error': 'not found'})",
  "            return",
  "",
  "        query = parse_qs(parsed.query)",
  "        label = query.get('label', [''])[0]",
  "        search_query = query.get('q', [''])[0]",
  "        if not label:",
  "            self.respond(400, {'error': 'label is required'})",
  "            return",
  "",
  "        concurrent_calls_at_release = self.wait_for_barrier()",
  "        if concurrent_calls_at_release is None:",
  "            self.respond(504, {'error': f'timed out waiting for {BARRIER_SIZE} concurrent calls'})",
  "            return",
  "",
  "        self.respond(200, {",
  "            'label': label,",
  "            'query': search_query,",
  "            'concurrentCallsAtRelease': concurrent_calls_at_release,",
  "        })",
  "",
  "    def wait_for_barrier(self):",
  "        global arrived, released_count",
  "        deadline = monotonic() + BARRIER_TIMEOUT_SECONDS",
  "        with barrier:",
  "            if released_count is not None:",
  "                return released_count",
  "            arrived += 1",
  "            if arrived == BARRIER_SIZE:",
  "                released_count = arrived",
  "                barrier.notify_all()",
  "                return released_count",
  "            while released_count is None:",
  "                remaining = deadline - monotonic()",
  "                if remaining <= 0:",
  "                    return None",
  "                barrier.wait(remaining)",
  "            return released_count",
  "",
  "    def log_message(self, format, *args):",
  "        return",
  "",
  "    def respond(self, status, body):",
  "        encoded = json.dumps(body).encode('utf-8')",
  "        self.send_response(status)",
  "        self.send_header('Content-Type', 'application/json')",
  "        self.send_header('Content-Length', str(len(encoded)))",
  "        self.end_headers()",
  "        self.wfile.write(encoded)",
  "",
  `ThreadingHTTPServer(('127.0.0.1', ${FANOUT_SERVER_PORT}), Handler).serve_forever()`,
  "",
].join("\n");

const authorSnapshotId = process.env.EVE_TEST_AUTHOR_SNAPSHOT_ID;
const backend =
  authorSnapshotId !== undefined
    ? vercel({ source: { snapshotId: authorSnapshotId, type: "snapshot" } })
    : defaultBackend();

export default defineSandbox({
  backend,
  // Bump when the bootstrap output changes so the reusable template snapshot
  // is rebuilt rather than served stale.
  revalidationKey: () => "agent-tools-sandbox-bootstrap-v2",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_MARKER_PATH,
      content: SANDBOX_MARKER_TOKEN,
    });
    // Install a custom CLI onto the PATH and make it executable. Later
    // sessions inherit it from the template without re-running bootstrap.
    await sandbox.writeTextFile({ path: SANDBOX_CLI_PATH, content: CLI_SCRIPT });
    const chmod = await sandbox.run({ command: `chmod +x ${SANDBOX_CLI_PATH}` });
    if (chmod.exitCode !== 0) {
      throw new Error(`bootstrap: chmod of ${SANDBOX_CLI_PATH} failed: ${chmod.stderr}`);
    }
  },
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_SESSION_MARKER_PATH,
      content: SANDBOX_SESSION_MARKER_TOKEN,
    });
    await sandbox.writeTextFile({ path: FANOUT_SERVER_PATH, content: FANOUT_SERVER_SCRIPT });
    const startServer = await sandbox.run({
      command: [
        `if ! curl -fsS http://127.0.0.1:${FANOUT_SERVER_PORT}/health >/dev/null; then`,
        `  nohup python3 ${FANOUT_SERVER_PATH} >${FANOUT_SERVER_LOG_PATH} 2>&1 &`,
        "fi",
        "for attempt in $(seq 1 50); do",
        `  if curl -fsS http://127.0.0.1:${FANOUT_SERVER_PORT}/health >/dev/null; then exit 0; fi`,
        "  sleep 0.1",
        "done",
        `cat ${FANOUT_SERVER_LOG_PATH} >&2`,
        "exit 1",
      ].join("\n"),
    });
    if (startServer.exitCode !== 0) {
      throw new Error(`Fanout server failed to start: ${startServer.stderr}`);
    }
  },
});
