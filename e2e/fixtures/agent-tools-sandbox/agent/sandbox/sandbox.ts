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
 *   inherits.
 * - `onSession` runs once per live session. It writes a per-session marker
 *   so an eval can prove session-scoped setup ran on top of the shared
 *   template.
 *
 * Backend is left as the framework default so this fixture works both
 * locally (where `defaultBackend()` resolves to `docker()`) and on Vercel
 * deployments (where it resolves to `vercel()`). Both run the published eve
 * base image: GHCR locally and VCR on Vercel. CI sets `EVE_SANDBOX_IMAGE_TAG`
 * to `latest` so release PRs can run before their versioned image exists. The
 * image ships Node and git; the bootstrap below assumes that real-binary
 * environment and is not meant to run against the dependency-free `just-bash`
 * fallback.
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
 * Custom CLI installed during bootstrap. The base image puts the sandbox
 * user's npm global prefix on PATH, so the same install works across backends.
 */
const SANDBOX_CLI_DIRECTORY_PATH = "/home/vercel-sandbox/.local/bin";
export const SANDBOX_CLI_PATH = `${SANDBOX_CLI_DIRECTORY_PATH}/eve-greet`;
export const SANDBOX_CLI_TOKEN = "eve-greet-cli-ok-R7M";

/** Per-session marker written by `onSession` (live session, not the template). */
export const SANDBOX_SESSION_MARKER_PATH = "/workspace/session-marker.txt";
export const SANDBOX_SESSION_MARKER_TOKEN = "sandbox-onsession-ok-X5T";

const FANOUT_SERVER_PORT = 43_100;
const FANOUT_SERVER_PATH = "/workspace/eve-fanout-server.mjs";
const FANOUT_SERVER_LOG_PATH = "/workspace/eve-fanout-server.log";
const FANOUT_BARRIER_SIZE = 10;
const FANOUT_BARRIER_TIMEOUT_MILLISECONDS = 15_000;

const CLI_SCRIPT = [
  "#!/usr/bin/env node",
  `const name = process.argv[2] ?? "world";`,
  `console.log("${SANDBOX_CLI_TOKEN}:" + name);`,
  "",
].join("\n");

const FANOUT_SERVER_SCRIPT = [
  'import http from "node:http";',
  "",
  `const barrierSize = ${FANOUT_BARRIER_SIZE};`,
  `const barrierTimeoutMilliseconds = ${FANOUT_BARRIER_TIMEOUT_MILLISECONDS};`,
  "let arrived = 0;",
  "let releasedCount = null;",
  "const waiters = new Set();",
  "",
  "function respond(response, status, body) {",
  "  const encoded = JSON.stringify(body);",
  '  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });',
  "  response.end(encoded);",
  "}",
  "",
  "function waitForBarrier() {",
  "  if (releasedCount !== null) return Promise.resolve(releasedCount);",
  "  return new Promise((resolve) => {",
  "    let timeout;",
  "    const waiter = (count) => {",
  "      clearTimeout(timeout);",
  "      resolve(count);",
  "    };",
  "    timeout = setTimeout(() => {",
  "      waiters.delete(waiter);",
  "      resolve(null);",
  "    }, barrierTimeoutMilliseconds);",
  "    waiters.add(waiter);",
  "    arrived += 1;",
  "    if (arrived !== barrierSize) return;",
  "    releasedCount = arrived;",
  "    for (const waiting of waiters) waiting(releasedCount);",
  "    waiters.clear();",
  "  });",
  "}",
  "",
  "const server = http.createServer(async (request, response) => {",
  `  const url = new URL(request.url, "http://127.0.0.1:${FANOUT_SERVER_PORT}");`,
  '  if (url.pathname === "/health") {',
  "    respond(response, 200, { ok: true });",
  "    return;",
  "  }",
  '  if (url.pathname !== "/barrier") {',
  '    respond(response, 404, { error: "not found" });',
  "    return;",
  "  }",
  '  const label = url.searchParams.get("label") ?? "";',
  '  const searchQuery = url.searchParams.get("q") ?? "";',
  "  if (!label) {",
  '    respond(response, 400, { error: "label is required" });',
  "    return;",
  "  }",
  "  const concurrentCallsAtRelease = await waitForBarrier();",
  "  if (concurrentCallsAtRelease === null) {",
  "    respond(response, 504, { error: `timed out waiting for ${barrierSize} concurrent calls` });",
  "    return;",
  "  }",
  "  respond(response, 200, { label, query: searchQuery, concurrentCallsAtRelease });",
  "});",
  `server.listen(${FANOUT_SERVER_PORT}, "127.0.0.1");`,
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
  revalidationKey: () => "agent-tools-sandbox-bootstrap-v4",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_MARKER_PATH,
      content: SANDBOX_MARKER_TOKEN,
    });
    // Install a custom CLI onto the PATH and make it executable. Later
    // sessions inherit it from the template without re-running bootstrap.
    const mkdir = await sandbox.run({ command: `mkdir -p ${SANDBOX_CLI_DIRECTORY_PATH}` });
    if (mkdir.exitCode !== 0) {
      throw new Error(`bootstrap: failed to create CLI directory: ${mkdir.stderr}`);
    }
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
        `  nohup node ${FANOUT_SERVER_PATH} >${FANOUT_SERVER_LOG_PATH} 2>&1 &`,
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
