import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Run against two separately built package directories, sequentially, on the same machine.
// Each process is fresh; subsequent runs retain the fixture's caches and build output.
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

for (let run = 1; run <= runs; run++) {
  for (const mode of ["dev", "build"]) {
    const port = await availablePort();
    const profilePath = join(root, `build-${run}.json`);
    const args =
      mode === "dev"
        ? ["dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)]
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
        let ready = false;
        while (performance.now() - start < 60000) {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(log);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/eve/v1/info`, {
              signal: AbortSignal.timeout(5000),
            });
            const body = await response.text();
            if (response.ok) {
              JSON.parse(body);
              ready = true;
              break;
            }
          } catch {}
          await delay(20);
        }
        if (!ready) throw new Error(`Readiness timeout: ${log}`);
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
        });
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
for (const mode of ["dev", "build"]) {
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
