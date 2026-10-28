// Start eve dev with a fresh Vercel project identity so it shares the deployment's cloud browser.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";

const root = new URL("..", import.meta.url).pathname;
const env = { ...process.env };
if (existsSync(join(root, ".vercel/project.json"))) {
  // The identity expires after hours; pull to a temporary file so .env.local is never rewritten.
  const directory = await mkdtemp(join(tmpdir(), "eve-dev-identity-"));
  try {
    await promisify(execFile)("vercel", ["env", "pull", join(directory, ".env"), "--yes"], {
      cwd: root,
    });
    const token = parseEnv(await readFile(join(directory, ".env"), "utf8")).VERCEL_OIDC_TOKEN;
    if (token) env.VERCEL_OIDC_TOKEN = token;
    else console.warn("Vercel returned no project identity; the cloud browser is unavailable.");
  } catch {
    console.warn(
      "Could not refresh the Vercel project identity. Run vercel login; the cloud browser is unavailable until then.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else {
  console.warn("Run ./scripts/setup.sh to link a Vercel project and enable the cloud browser.");
}
const child = spawn(
  process.execPath,
  [
    "--env-file-if-exists=.env.local",
    "node_modules/eve/bin/eve.js",
    "dev",
    "--no-ui",
    "--no-default-extensions",
  ],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
