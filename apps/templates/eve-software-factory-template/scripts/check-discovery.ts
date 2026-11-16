import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// eve info can exit zero on compilation failure; inspect the report itself.
const result = spawnSync(
  process.execPath,
  [join(root, "node_modules/eve/bin/eve.js"), "info", "--json"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      FACTORY_REPO: "acme/widgets",
      GITHUB_CONNECTOR: "github/foreman-agent",
      LINEAR_CONNECTOR: "linear/foreman-agent",
      ...process.env,
      EVE_TELEMETRY_DISABLED: "1",
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  }
);
try {
  const report = JSON.parse(result.stdout) as {
    diagnostics?: { errors?: number; warnings?: number };
    status?: string;
  };
  if (
    result.status !== 0 ||
    report.status !== "ready" ||
    report.diagnostics?.errors !== 0 ||
    report.diagnostics?.warnings !== 0
  ) {
    throw new Error("Discovery is not clean.");
  }
  console.log("eve discovery: ready, 0 errors, 0 warnings.");
} catch {
  console.error('eve discovery failed. Run "eve info" for diagnostics.');
  process.exitCode = 1;
}
