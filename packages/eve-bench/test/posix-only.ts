// eve-bench drives Linux task containers, and its integration tests stub POSIX
// tools (sh, shebang scripts, process groups), so they cannot run on Windows hosts.
import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  console.log("Skipping eve-bench integration tests: they require a POSIX host.");
  process.exit(0);
}
const { status } = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(status ?? 1);
