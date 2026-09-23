import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = resolve(process.argv[2] ?? process.cwd());
const planPath = resolve(process.argv[3] ?? "plan.json");
const outputPath = resolve(process.argv[4] ?? "checkouts.json");
const worktrees = resolve(process.argv[5] ?? ".experiment-worktrees");
const plan = JSON.parse(await (await import("node:fs/promises")).readFile(planPath, "utf8"));
await mkdir(worktrees, { recursive: true });
const checkouts = {};
for (const variant of plan.variants) {
  const path = join(worktrees, variant.label);
  await execFile("git", ["worktree", "remove", "--force", path], { cwd: root }).catch(() => {});
  await execFile("git", ["worktree", "add", "--detach", path, variant.sha], { cwd: root });
  checkouts[variant.label] = path;
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
  const fixtureNames = [...new Set(plan.fixtures.map((fixture) => fixture.name))];
  for (const fixture of fixtureNames) {
    const fixtureRoot = join(path, "e2e", "fixtures", fixture);
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
    const resolvedPackage = resolve(resolution.stdout.trim());
    if (!resolvedPackage.startsWith(`${join(path, "packages", "eve")}/`))
      throw new Error(
        `Fixture ${fixture} did not resolve its checkout's built eve package: ${resolvedPackage}`,
      );
  }
}
await writeFile(outputPath, `${JSON.stringify(checkouts, null, 2)}\n`);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = 0;
