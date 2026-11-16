import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

// What someone new waits through from the getting-started command,
// `npx eve@latest init my-agent`, to a running agent. Packs the built package
// directory the way pkg.eve.dev does (`pnpm pack`), then, per run, runs
// `npx --package <tarball> -- eve init my-agent` in an empty directory with an
// empty npm cache and an empty home directory, in a pseudo-terminal so init takes the interactive path
// the docs describe: it scaffolds the project, installs its dependencies,
// initializes Git, and opens the terminal UI (`eve dev --onboard`). The
// project's own `eve` dependency points at the same tarball
// (EVE_INIT_PACKAGE_SPEC), since the commit under test isn't on npm.
//
// Every run is cold: npx downloads eve's dependencies, and the project
// install reuses that cache, as it would for a first-time user. Dependencies
// resolve from the registry on the day the job runs, so a dependency release
// can move these timings with no eve change (as for the package probe).
//
// Per run, each timed from spawning npx except installMs, an interval:
//   downloadMs       eve's first progress line ("Creating agent"): npx
//                    downloading eve's dependencies, installing them with
//                    eve, and the CLI starting; eve itself is the local
//                    tarball, so its own download isn't included
//   installMs        "Installing dependencies" to "Initializing Git": eve's
//                    own install of the new project
//   createdMs        "Created an eve agent": scaffold, install, and Git done
//   promptVisibleMs  the terminal UI's first frame showing the prompt
//   readyMs          the dev server's first /eve/v1/info 200 (PORT pins the
//                    port it binds)
//
// Timing stops at ready. Onboarding then asks the person to connect a model
// provider (there are no credentials here), which no run waits on.
//
// One JSON object per line: a header, then one result per run. Each run's
// terminal output is kept as init-<run>.log in <log-dir> (default: the
// header's `root`).
//
// Usage: node packages/eve/scripts/benchmark-init.mjs <package-dir> [runs] [log-dir]
const packageRoot = resolve(process.argv[2] ?? "packages/eve");
const runs = Number(process.argv[3] ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Expected a positive run count.");
if (process.platform !== "linux" && process.platform !== "darwin")
  throw new Error("The init benchmark needs `script` for a pseudo-terminal (Linux or macOS).");
const RUN_TIMEOUT_MS = 5 * 60_000;
const PROJECT_NAME = "my-agent";
const PROMPT_GLYPH = "❯";
const MARKERS = {
  download: "Creating agent",
  installStart: "Installing dependencies",
  installEnd: "Initializing Git",
  created: "Created an",
};
const PROBE_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 20;
// The prompt normally draws before the server is ready; this long after ready,
// it isn't coming, and waiting on would only run into RUN_TIMEOUT_MS.
const PROMPT_GRACE_MS = 30_000;
const LOG_TAIL_CHARS = 2000;
// Coding-agent markers @vercel/detect-agent (1.2.7) reads: init takes a
// non-interactive path when it thinks an agent launched it. It also checks for
// /opt/.devin, which no environment variable can hide.
const AGENT_ENV = [
  "AI_AGENT",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_MODEL",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "OPENCODE",
  "OPENCODE_CLIENT",
  "REPL_ID",
];

const root = await mkdtemp(join(tmpdir(), "eve-init-benchmark-"));
const tarball = join(root, "eve.tgz");
const logDir = resolve(process.argv[4] ?? root);
await mkdir(logDir, { recursive: true });
const baseEnv = {
  ...process.env,
  EVE_TELEMETRY_DISABLED: "1",
  EVE_INIT_PACKAGE_SPEC: `file:${tarball}`,
  // Runners have no Git identity; without one init's commit fails (and says so).
  GIT_AUTHOR_NAME: "eve benchmark",
  GIT_AUTHOR_EMAIL: "benchmark@eve.invalid",
  GIT_COMMITTER_NAME: "eve benchmark",
  GIT_COMMITTER_EMAIL: "benchmark@eve.invalid",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  TERM: "xterm-256color",
};
// A first-time user has no credentials; dropping them keeps runs comparable.
// Saved ones (eve's and the Vercel CLI's) live under the home directory, which
// each run replaces. CI turns off init's animated progress, which a person sees.
for (const name of [
  ...AGENT_ENV,
  "CI",
  "VERCEL",
  "EVE_DEV",
  "PORT",
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "VERCEL_TOKEN",
  "VERCEL_OIDC_TOKEN",
])
  delete baseEnv[name];
// Applied per run only, so packing (a workspace build) keeps the real home.
const HOME_ENV = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "GIT_CONFIG_GLOBAL",
];

const npmVersion = await output("npm", ["--version"], { env: baseEnv });
console.log(
  JSON.stringify({
    root,
    packageRoot,
    node: process.version,
    npm: npmVersion.trim(),
    platform: process.platform,
    arch: process.arch,
  }),
);
await output("pnpm", ["--dir", packageRoot, "pack", "--out", tarball], { env: baseEnv });

const results = [];
for (let run = 1; run <= runs; run++) {
  const dir = join(root, `run-${run}`);
  const cache = join(root, `npm-cache-${run}`);
  const home = join(root, `home-${run}`);
  await mkdir(dir);
  await mkdir(home);
  const port = await availablePort();
  const env = { ...baseEnv, HOME: home, npm_config_cache: cache, PORT: String(port) };
  for (const name of HOME_ENV) delete env[name];
  const seen = {};
  let log = "";
  const start = performance.now();
  const child = spawnInTerminal(
    ["npx", "--yes", "--package", tarball, "--", "eve", "init", PROJECT_NAME],
    {
      cwd: dir,
      env,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Writing Ctrl-C at teardown can race `script` exiting (EPIPE).
  child.stdin.on("error", () => {});
  let promptSeen;
  const promptVisible = new Promise((resolvePrompt) => {
    promptSeen = resolvePrompt;
  });
  let createdSeen;
  const created = new Promise((resolveCreated) => {
    createdSeen = resolveCreated;
  });
  child.stdout.on("data", (data) => {
    log += data;
    const now = Math.round(performance.now() - start);
    for (const [name, text] of Object.entries(MARKERS)) {
      if (seen[name] === undefined && log.includes(text)) {
        seen[name] = now;
        if (name === "created") createdSeen();
      }
    }
    // The prompt counts only once init has handed off to the terminal UI.
    if (
      seen.created !== undefined &&
      seen.prompt === undefined &&
      log.slice(log.indexOf(MARKERS.created)).includes(PROMPT_GLYPH)
    ) {
      seen.prompt = now;
      promptSeen();
    }
  });
  child.stderr.on("data", (data) => {
    log += data;
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  try {
    await Promise.race([created, exited]);
    if (seen.created === undefined)
      throw new Error(`eve init exited before creating the project:\n${tail(log)}`);
    let readyError;
    const readyMs = await waitReady(child, port, "/eve/v1/info", start).then(
      () => Math.round(performance.now() - start),
      (error) => {
        readyError = error;
        return undefined;
      },
    );
    // A clean exit before ready is init's coding-agent path, which never runs
    // `eve dev`: not the path this measures.
    if (readyMs === undefined && child.exitCode === 0)
      throw new Error(
        `eve init exited after creating the project instead of starting eve dev, as it does when it detects a coding agent; unset that agent's environment variable:\n${tail(log)}`,
      );
    await Promise.race([promptVisible, exited, delay(PROMPT_GRACE_MS, undefined, { ref: false })]);
    const result = {
      run,
      mode: "init",
      downloadMs: seen.download,
      installMs:
        seen.installStart !== undefined && seen.installEnd !== undefined
          ? seen.installEnd - seen.installStart
          : undefined,
      createdMs: seen.created,
      promptVisibleMs: seen.prompt,
      readyMs,
    };
    if (readyError !== undefined)
      console.error(
        `init run ${run}: the dev server never became ready (${readyError.message}):\n${tail(log)}`,
      );
    if (result.promptVisibleMs === undefined)
      console.error(
        `init run ${run}: the terminal UI never showed its prompt; see ${join(logDir, `init-${run}.log`)}.`,
      );
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    // One failed run is recorded as missing; the others still count.
    console.error(`init run ${run} failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.stdin.write("\x03\x03");
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(killer);
    await writeFile(join(logDir, `init-${run}.log`), log);
    // The next run starts from nothing; only the tarball and logs are kept.
    await rm(dir, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

// A summary for reading locally; records read only the per-run lines.
const median = (values) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)];
};
console.log(
  JSON.stringify({
    mode: "init",
    createdMedianMs: median(results.map((r) => r.createdMs)),
    readyMedianMs: median(results.map((r) => r.readyMs)),
  }),
);

function output(command, args, options) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveOutput(stdout)
        : reject(new Error(`${command} ${args.join(" ")}: ${stderr}`)),
    );
  });
}

/** The end of a run's terminal output, readable in a CI log. */
function tail(log) {
  return stripVTControlCharacters(log).slice(-LOG_TAIL_CHARS);
}

/** Resolves when a probe of `path` first answers 200 with JSON; overlapping probes, as in benchmark-startup.mjs. */
function waitReady(child, port, path, start) {
  const outstanding = new AbortController();
  return new Promise((resolveReady, reject) => {
    let timer;
    let done = false;
    const finish = (settle) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      outstanding.abort();
      settle();
    };
    const probe = async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        return finish(() => reject(new Error("eve exited")));
      if (performance.now() - start >= RUN_TIMEOUT_MS)
        return finish(() => reject(new Error("Readiness timeout")));
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.any([outstanding.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        });
        const body = await response.text();
        if (response.ok) {
          JSON.parse(body);
          finish(() => resolveReady());
        }
      } catch {
        // Not up yet.
      }
    };
    timer = setInterval(probe, PROBE_INTERVAL_MS);
    void probe();
  });
}

/** Spawns `argv` in a fixed-size pseudo-terminal through `script`, as benchmark-startup.mjs does. */
function spawnInTerminal(argv, options) {
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  const command = `stty cols 120 rows 40; exec ${argv.map(quote).join(" ")}`;
  const scriptArgs =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "sh", "-c", command]
      : ["-qfec", `sh -c ${quote(command)}`, "/dev/null"];
  return spawn("script", scriptArgs, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}
