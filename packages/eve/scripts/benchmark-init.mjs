import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// What someone new waits through from the getting-started command,
// `npx eve@latest init my-agent`, to a running agent. Packs the built package
// directory the way pkg.eve.dev does (`pnpm pack`), then, per run, runs
// `npx --package <tarball> -- eve init my-agent` in an empty directory with an
// empty npm cache, in a pseudo-terminal so init takes the interactive path
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
// Per run, each timed from spawning npx:
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
// terminal output is kept as init-<run>.log in the header's `root`.
//
// Usage: node packages/eve/scripts/benchmark-init.mjs <package-dir> [runs]
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
// Coding-agent markers @vercel/detect-agent reads: init takes a
// non-interactive path when it thinks an agent launched it.
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
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "OPENCODE_CLIENT",
  "REPL_ID",
];

const root = await mkdtemp(join(tmpdir(), "eve-init-benchmark-"));
const tarball = join(root, "eve.tgz");
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
for (const name of [
  ...AGENT_ENV,
  "VERCEL",
  "EVE_DEV",
  "PORT",
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
])
  delete baseEnv[name];

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
  await mkdir(dir);
  const port = await availablePort();
  const env = { ...baseEnv, npm_config_cache: cache, PORT: String(port) };
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
      throw new Error(`eve init exited before creating the project; see init-${run}.log.`);
    const [ready] = await Promise.allSettled([
      waitReady(child, port, "/eve/v1/info", start, () => log).then(() =>
        Math.round(performance.now() - start),
      ),
      Promise.race([promptVisible, exited]),
    ]);
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
      readyMs: ready.status === "fulfilled" ? ready.value : undefined,
    };
    if (ready.status === "rejected")
      console.error(
        `init run ${run}: the dev server never became ready: ${ready.reason?.message ?? ready.reason}`,
      );
    if (result.promptVisibleMs === undefined)
      console.error(
        `init run ${run}: the terminal UI never showed its prompt; see init-${run}.log.`,
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
    await writeFile(join(root, `init-${run}.log`), log);
    // The next run starts from nothing; only the tarball and logs are kept.
    await rm(dir, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
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

/** Resolves when a probe of `path` first answers 200 with JSON; overlapping probes, as in benchmark-startup.mjs. */
function waitReady(child, port, path, start, readLog) {
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
        return finish(() => reject(new Error(readLog().slice(-2000))));
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
