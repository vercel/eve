import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const token = process.env.VERCEL_TOKEN?.trim();
if (!token) {
  throw new Error(
    'VERCEL_TOKEN is required. Create one with `vercel tokens add "dynamic schedules local test" --project <project-id> --scope <team>` or export an existing personal token.',
  );
}

let link;
try {
  link = JSON.parse(await readFile(new URL("../.vercel/project.json", import.meta.url), "utf8"));
} catch {
  throw new Error(
    "This fixture is not linked to a Vercel project. Run `vercel link --cwd apps/fixtures/dynamic-schedules` first.",
  );
}

if (typeof link.projectId !== "string" || link.projectId.trim().length === 0) {
  throw new Error("The linked Vercel project does not contain a projectId.");
}

const child = spawn("eve", ["dev"], {
  env: {
    ...process.env,
    EVE_TEST_ONLY_DYNAMIC_SCHEDULES_VERCEL_PROJECT_ID: link.projectId,
    EVE_TEST_ONLY_DYNAMIC_SCHEDULES_VERCEL_TOKEN: token,
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
