import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const execFile = promisify(execFileCallback);
const root = resolve(process.argv[2] ?? process.cwd());
const planPath = resolve(process.argv[3] ?? "plan.json");
const outputPath = resolve(process.argv[4] ?? "checkouts.json");
const worktrees = resolve(process.argv[5] ?? ".experiment-worktrees");
const plan = JSON.parse(await readFile(planPath, "utf8"));
await mkdir(worktrees, { recursive: true });
const checkouts = {};
for (const source of plan.sources) {
  const path = join(worktrees, source.label);
  await execFile("git", ["worktree", "remove", "--force", path], { cwd: root }).catch(() => {});
  await execFile("git", ["worktree", "add", "--detach", path, source.sha], { cwd: root });
  checkouts[source.label] = path;
  await execFile("pnpm", ["install", "--frozen-lockfile"], {
    cwd: path,
    timeout: 10 * 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  await execFile("pnpm", ["--filter", "eve", "run", "build"], {
    cwd: path,
    timeout: 20 * 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  for (const fixture of plan.fixtures) {
    const fixtureRoot = join(path, "e2e", "fixtures", fixture.name);
    await execFile("pnpm", ["run", "--if-present", "e2e:prepare"], {
      cwd: fixtureRoot,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const resolution = await execFile(
      "node",
      ["--input-type=module", "-e", 'console.log(import.meta.resolve("eve"))'],
      { cwd: fixtureRoot },
    );
    const resolvedPackage = fileURLToPath(resolution.stdout.trim());
    if (!resolvedPackage.startsWith(`${join(path, "packages", "eve")}/`))
      throw new Error(
        `Fixture ${fixture.name} did not resolve its checkout's built eve package: ${resolvedPackage}`,
      );
    if (fixture.name === "agent-self-modification") {
      const prepare = await readFile(join(fixtureRoot, "scripts/prepare.mjs"), "utf8");
      const agent = await readFile(join(fixtureRoot, "agent/agent.ts"), "utf8");
      if (
        !prepare.includes("EVE_EXPERIMENT_SELF_MODIFICATION_MODEL") ||
        !prepare.includes("EVE_EXPERIMENT_SELF_MODIFICATION_REASONING") ||
        !agent.includes("EVE_EXPERIMENT_PARENT_MODEL") ||
        !agent.includes("EVE_EXPERIMENT_PARENT_REASONING")
      )
        throw new Error(`Source ${source.label} cannot honor the scoped settings contract.`);
    }
  }
}
await writeFile(outputPath, `${JSON.stringify(checkouts, null, 2)}\n`);
