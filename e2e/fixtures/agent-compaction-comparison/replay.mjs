// Runs the replay eval once per strategy, then prints what each run measured.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const strategies = ["default", "opencode", "codex"];
rmSync(".replay", { force: true, recursive: true });
let failed = false;
for (const strategy of strategies) {
  const run = spawnSync("pnpm", ["exec", "eve", "eval", ...process.argv.slice(2)], {
    env: { ...process.env, EVE_COMPACTION_STRATEGY: strategy },
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (run.error) throw run.error;
  failed ||= run.status !== 0;
}
const results = strategies.map((strategy) => {
  try {
    return JSON.parse(readFileSync(`.replay/${strategy}.json`, "utf8"));
  } catch {
    return { strategy, missing: true };
  }
});
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
