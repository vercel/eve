import { DefaultSandbox, defineSandbox, type SandboxSession } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/**
 * Sandbox lifecycle fixture exercising the surfaces an agent author relies
 * on. The matching evals live under `evals/sandbox/` and assert each piece
 * end-to-end through a real provider.
 *
 * - `prepare()` runs once per sandbox environment generation. It writes a
 *   marker and installs a custom CLI (`eve-greet`) that every later session
 *   inherits. The CLI also proves the base image can execute Python.
 * - The selector writes a marker and starts a loopback server once when the
 *   durable session first opens its sandbox.
 *
 * The default environment keeps this fixture portable between local providers
 * and Vercel Sandbox. Both run the published eve
 * base image: GHCR locally and VCR on Vercel. CI sets `EVE_SANDBOX_IMAGE_TAG`
 * to `latest` so release PRs can run before their versioned image exists. The
 * image ships Python, Node, and git; the preparation below assumes
 * that real-binary environment and is not meant to run against the
 * dependency-free `just-bash` fallback.
 *
 * `EVE_TEST_AUTHOR_SNAPSHOT_ID`, when set, overrides the provider with
 * `VercelSandbox.environment({ prepare })` with a snapshot source so the author-snapshot
 * smoke test can verify that an author-supplied snapshot remains the base
 * layer while environment preparation runs on top.
 */
export const SANDBOX_MARKER_PATH = "/workspace/smoke-marker.txt";
export const SANDBOX_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";

/**
 * Custom CLI installed during preparation. The base image puts the sandbox
 * user's npm global prefix on PATH, so the same install works across providers.
 */
const SANDBOX_CLI_DIRECTORY_PATH = "/home/vercel-sandbox/.local/bin";
export const SANDBOX_CLI_PATH = `${SANDBOX_CLI_DIRECTORY_PATH}/eve-greet`;
export const SANDBOX_CLI_TOKEN = "eve-greet-cli-ok-R7M";

/** Per-session marker written by the selector, not environment preparation. */
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
const prepareEnvironment = async (sandbox: SandboxSession) => {
  await sandbox.writeTextFile({ path: SANDBOX_MARKER_PATH, content: SANDBOX_MARKER_TOKEN });
  const mkdir = await sandbox.run({ command: `mkdir -p ${SANDBOX_CLI_DIRECTORY_PATH}` });
  if (mkdir.exitCode !== 0)
    throw new Error(`prepare: failed to create CLI directory: ${mkdir.stderr}`);
  await sandbox.writeTextFile({ path: SANDBOX_CLI_PATH, content: CLI_SCRIPT });
  const chmod = await sandbox.run({ command: `chmod +x ${SANDBOX_CLI_PATH}` });
  if (chmod.exitCode !== 0) throw new Error(`prepare: chmod failed: ${chmod.stderr}`);
};

export const environment =
  authorSnapshotId === undefined
    ? DefaultSandbox.environment({ prepare: prepareEnvironment })
    : VercelSandbox.environment({
        prepare: prepareEnvironment,
        source: { snapshotId: authorSnapshotId, type: "snapshot" },
      });

export default defineSandbox(async () => {
  const sandbox = await environment.create();
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
  if (startServer.exitCode !== 0)
    throw new Error(`Fanout server failed to start: ${startServer.stderr}`);
  return sandbox;
});
