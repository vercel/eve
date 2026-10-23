import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Run against two separately built package directories, sequentially, on the same machine.
// Each process is fresh; subsequent runs retain the fixture's caches and build output.
// Per run: `eve dev` to /eve/v1/info and a first session, `eve build --profile`,
// then `eve start` on that build to /eve/v1/health. One JSON result per line.
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
  'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });\n',
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

// Each readiness request gets a short deadline of its own. If an early request
// is accepted but never answered (the port can open before the server serves),
// a long deadline would stall the probe and be measured as startup time.
const PROBE_TIMEOUT_MS = 1000;
const PROBE_INTERVAL_MS = 20;

for (let run = 1; run <= runs; run++) {
  // `start` serves the output `build` just wrote, so it runs after it.
  for (const mode of ["dev", "build", "start"]) {
    const port = await availablePort();
    const profilePath = join(root, `build-${run}.json`);
    const args =
      mode === "dev"
        ? ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)]
        : mode === "start"
          ? ["start", "--host", "127.0.0.1", "--port", String(port)]
          : ["build", "--profile", profilePath];
    let log = "";
    const start = performance.now();
    const child = spawn(process.execPath, [join(packageRoot, "bin", "eve.js"), ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data;
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
        const accepted = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, {
          method: "POST",
          signal: AbortSignal.timeout(10000),
        });
        const session = await accepted.json();
        if (!accepted.ok || typeof session.sessionId !== "string") {
          throw new Error(
            `Session creation failed (${accepted.status}): ${JSON.stringify(session)}`,
          );
        }
        results.push({
          run,
          mode,
          wallMs,
          sessionAcceptedMs: Math.round(performance.now() - start),
          status: 200,
          probes,
        });
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
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await exited;
      clearTimeout(killer);
      await writeFile(join(root, `${mode}-${run}.log`), log);
    }
  }
}
await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
for (const mode of ["dev", "build", "start"]) {
  const times = results
    .filter((result) => result.mode === mode)
    .map((result) => result.wallMs)
    .sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode,
      medianMs: times[Math.floor(times.length / 2)],
      minMs: times[0],
      maxMs: times.at(-1),
    }),
  );
}

/**
 * Polls `path` until it answers 200 with JSON. Returns how the probes went, so
 * a measurement that includes stalled requests is visible in the results:
 * `attempts` requests in all, `timedOut` that hit the per-request deadline,
 * `refused` that failed to connect, and `stalledMs`, the time spent in
 * requests that timed out.
 */
async function waitReady(child, port, path, start, readLog) {
  const probes = { attempts: 0, timedOut: 0, refused: 0, stalledMs: 0 };
  while (performance.now() - start < 60000) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(readLog());
    probes.attempts += 1;
    const sent = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = await response.text();
      if (response.ok) {
        JSON.parse(body);
        return probes;
      }
    } catch (error) {
      if (error?.name === "TimeoutError") {
        probes.timedOut += 1;
        probes.stalledMs += Math.round(performance.now() - sent);
      } else if (error?.cause?.code === "ECONNREFUSED") probes.refused += 1;
    }
    await delay(PROBE_INTERVAL_MS);
  }
  throw new Error(`Readiness timeout: ${readLog()}`);
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
