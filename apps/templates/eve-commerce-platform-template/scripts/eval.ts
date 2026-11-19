// Runs the agent eval suite against the local Docker Compose database.
//
//   pnpm eval                 # every case
//   pnpm eval --tag shopping  # one family
//
// Shopping is stubbed and the browser service is pinned to an unreachable
// address, so evals never reach a real store or cloud browser. Model calls
// still need AI_GATEWAY_API_KEY (or a Vercel OIDC token) in .env.local.
import { spawnSync } from "node:child_process";

const localDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54329/evey";
const unreachable = "http://127.0.0.1:9";

const env = {
  ...process.env,
  // Placeholders enable the Agentcard tool so evals can stub it; a call
  // without a stub fails instead of reaching a real store.
  AGENTCARD_CLIENT_ID: "unused-by-evals",
  AGENTCARD_CLIENT_SECRET: "unused-by-evals",
  BETTER_AUTH_URL: unreachable,
  DATABASE_URL: localDatabaseUrl,
  DATABASE_URL_UNPOOLED: localDatabaseUrl,
  KERNEL_API_KEY: "unused-by-evals",
  KERNEL_BASE_URL: unreachable,
  NODE_ENV: "development" as const,
};

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("docker", ["compose", "up", "--detach", "--wait"]);
run("pnpm", ["db:migrate"]);
// Cases run one at a time so memory cases cannot leak into each other.
run("pnpm", [
  "exec",
  "eve",
  "eval",
  "agent",
  "--strict",
  "--max-concurrency",
  "1",
  ...process.argv.slice(2),
]);
