import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(process.argv[2] ?? "packages/eve");
const runs = Number(process.argv[3] ?? 5);
const toolCount = Number(process.argv[4] ?? 0);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Expected a positive run count.");
if (!Number.isInteger(toolCount) || toolCount < 0 || toolCount > 1000)
  throw new Error("Expected 0–1000 tools.");
const root = await mkdtemp(join(tmpdir(), "eve-startup-benchmark-"));
await mkdir(join(root, "agent", "channels"), { recursive: true });
await mkdir(join(root, "node_modules"));
await symlink(packageRoot, join(root, "node_modules", "eve"), "junction");
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies: { eve: "*" } }),
);
await writeFile(join(root, "agent", "instructions.md"), "You are a helpful assistant.\n");
await writeFile(
  join(root, "agent", "agent.ts"),
  'import { defineAgent } from "eve";\nimport { mockModel } from "eve/evals";\nexport default defineAgent({ model: mockModel("ready"), modelContextWindowTokens: 1_000_000 });\n',
);
await writeFile(
  join(root, "agent", "channels", "eve.ts"),
  'import { eveChannel } from "eve/channels/eve";\nimport { localDev } from "eve/channels/auth";\nexport default eveChannel({ auth: [localDev()] });\n',
);
if (toolCount > 0) {
  await mkdir(join(root, "agent", "tools"));
  for (let i = 0; i < toolCount; i++) {
    await writeFile(
      join(root, "agent", "tools", `tool_${i}.ts`),
      `export default { description: "Return fixture value ${i}.", execute: async () => ${i} };\n`,
    );
  }
}
const env = {
  ...process.env,
  EVE_TELEMETRY_DISABLED: "1",
  AI_GATEWAY_API_KEY: "benchmark-placeholder-no-model-calls",
};
delete env.VERCEL;
delete env.PORT;
delete env.EVE_DEV;
const { Client } = await import(
  pathToFileURL(createRequire(join(root, "package.json")).resolve("eve/client")).href
);
const results = [];
console.log(
  JSON.stringify({
    root,
    packageRoot,
    toolCount,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }),
);

const PROBE_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 20;

const ptyAvailable = process.platform === "linux" || process.platform === "darwin";
const PROMPT_GLYPH = "❯";

for (let run = 1; run <= runs; run++) {
  for (const mode of ["dev", "dev-tui", "build", "start"]) {
    if (mode === "dev-tui" && !ptyAvailable) continue;
    const port = await availablePort();
    const profilePath = join(root, `build-${run}.json`);
    const args =
      mode === "dev"
        ? ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)]
        : mode === "dev-tui"
          ? ["dev", "--host", "127.0.0.1", "--port", String(port)]
          : mode === "start"
            ? ["start", "--host", "127.0.0.1", "--port", String(port)]
            : ["build", "--profile", profilePath];
    let log = "";
    let promptVisibleMs;
    let promptSeen;
    const promptVisible = new Promise((resolvePrompt) => {
      promptSeen = resolvePrompt;
    });
    const start = performance.now();
    const eveArgv = [process.execPath, join(packageRoot, "bin", "eve.js"), ...args];
    const child =
      mode === "dev-tui"
        ? spawnInTerminal(eveArgv, { cwd: root, env: { ...env, TERM: "xterm-256color" } })
        : spawn(eveArgv[0], eveArgv.slice(1), {
            cwd: root,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
    child.stdout.on("data", (data) => {
      log += data;
      if (mode === "dev-tui" && promptVisibleMs === undefined && log.includes(PROMPT_GLYPH)) {
        promptVisibleMs = Math.round(performance.now() - start);
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    try {
      if (mode === "dev") {
        const probes = await waitReady(child, port, "/eve/v1/info", start, () => log);
        const wallMs = Math.round(performance.now() - start);
        const baseUrl = `http://127.0.0.1:${port}`;
        const client = new Client({ baseUrl, host: baseUrl });
        const signal = AbortSignal.timeout(30000);
        const created = await client.sessions.create({ message: "Hello", signal });
        const sessionAcceptedMs = Math.round(performance.now() - start);
        const turn = await (created.delivery ?? created.response).result();
        const firstTurnMs = Math.round(performance.now() - start);
        const reply = turn.reply ?? turn.message;
        if (reply !== "ready")
          throw new Error(`First turn ended without the mock reply: ${JSON.stringify(reply)}`);
        results.push({ run, mode, wallMs, sessionAcceptedMs, firstTurnMs, probes });
      } else if (mode === "dev-tui") {
        const probes = await waitReady(child, port, "/eve/v1/info", start, () => log);
        const wallMs = Math.round(performance.now() - start);
        await Promise.race([promptVisible, exited]);
        if (promptVisibleMs === undefined)
          throw new Error(`The terminal UI never showed its prompt; see dev-tui-${run}.log.`);
        results.push({ run, mode, wallMs, promptVisibleMs, probes });
      } else if (mode === "start") {
        const probes = await waitReady(child, port, "/eve/v1/health", start, () => log);
        results.push({ run, mode, wallMs: Math.round(performance.now() - start), probes });
      } else {
        const { code } = await exited;
        if (code !== 0) throw new Error(log);
        results.push({
          run,
          mode,
          wallMs: Math.round(performance.now() - start),
          profile: JSON.parse(await readFile(profilePath, "utf8")),
        });
      }
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      if (mode !== "dev-tui") throw error;
      console.error(`dev-tui run ${run} failed: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        if (mode === "dev-tui") child.stdin.write("\x03\x03");
        else child.kill("SIGINT");
      }
      const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await exited;
      clearTimeout(killer);
      await writeFile(join(root, `${mode}-${run}.log`), log);
    }
  }
  const uncached = await timeInfo(run, ["--fresh"]);
  const cached = uncached === undefined ? undefined : await timeInfo(run, []);
  results.push({
    run,
    mode: "info",
    wallMs: uncached ?? (await timeInfo(run, [])),
    cachedMs: cached,
  });
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
for (const mode of ["dev", "dev-tui", "build", "start", "info"]) {
  const times = results
    .filter((result) => result.mode === mode)
    .map((result) => result.wallMs)
    .sort((a, b) => a - b);
  if (times.length === 0) continue;
  console.log(
    JSON.stringify({
      mode,
      medianMs: times[Math.floor(times.length / 2)],
      minMs: times[0],
      maxMs: times.at(-1),
    }),
  );
}

async function timeInfo(run, flags) {
  const start = performance.now();
  const child = spawn(
    process.execPath,
    [join(packageRoot, "bin", "eve.js"), "info", "--json", ...flags],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  const wallMs = Math.round(performance.now() - start);
  const name = flags.includes("--fresh") ? "info-fresh" : "info";
  await writeFile(join(root, `${name}-${run}.log`), `${stdout}${stderr}`);
  if (code !== 0 && flags.includes("--fresh") && stderr.includes("unknown option '--fresh'"))
    return undefined;
  if (code !== 0) throw new Error(`eve info ${flags.join(" ")} exited with ${code}: ${stderr}`);
  const info = JSON.parse(stdout);
  if (info.status !== "ready" || info.tools.length < toolCount)
    throw new Error(`eve info reported ${info.status} with ${info.tools.length} tools.`);
  return wallMs;
}

function waitReady(child, port, path, start, readLog) {
  const probes = { attempts: 0, timedOut: 0, refused: 0 };
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
        return finish(() => reject(new Error(readLog())));
      if (performance.now() - start >= 60000)
        return finish(() => reject(new Error(`Readiness timeout: ${readLog()}`)));
      probes.attempts += 1;
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.any([outstanding.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        });
        const body = await response.text();
        if (response.ok) {
          JSON.parse(body);
          finish(() => resolveReady(probes));
        }
      } catch (error) {
        if (done) return;
        if (error?.name === "TimeoutError") probes.timedOut += 1;
        else if (error?.cause?.code === "ECONNREFUSED") probes.refused += 1;
      }
    };
    timer = setInterval(probe, PROBE_INTERVAL_MS);
    void probe();
  });
}

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
