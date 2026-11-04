import { spawnSync } from "node:child_process";
import { rename } from "node:fs/promises";

// Release candidates are the recommended install, so prereleases publish to
// npm's `latest` tag like stable releases. In pre mode Changesets publishes to
// the pre tag and rejects `--tag`, so publish with pre.json moved aside.
const preState = ".changeset/pre.json";
const parkedPreState = ".changeset/pre.json.publishing";

let parked = false;
try {
  await rename(preState, parkedPreState);
  parked = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

try {
  const { status, error } = spawnSync(
    process.execPath,
    ["node_modules/@changesets/cli/bin.js", "publish"],
    { stdio: "inherit" },
  );
  if (error) throw error;
  process.exitCode = status ?? 1;
} finally {
  if (parked) await rename(parkedPreState, preState);
}
