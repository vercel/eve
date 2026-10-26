// Boots the production build and signs up a user, so a Better Auth schema mismatch fails here
// instead of on the first sign-up after deploy. Run `pnpm build` first.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.env.SMOKE_PORT ?? 3917);
const origin = `http://localhost:${port}`;
const server = spawn(process.execPath, ["apps/web/.output/server/index.mjs"], {
  env: {
    ...process.env,
    PORT: String(port),
    BETTER_AUTH_SECRET: randomUUID(),
    BETTER_AUTH_URL: origin,
  },
  stdio: ["ignore", "inherit", "inherit"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
    try {
      await fetch(origin);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Server did not start on ${origin}`);
}

try {
  await waitForServer();
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: `smoke-${randomUUID()}@example.com`,
      password: randomUUID(),
      name: "Smoke Test",
    }),
  });
  if (!response.ok) {
    throw new Error(`Sign-up failed with ${response.status}: ${await response.text()}`);
  }
  console.log("Sign-up succeeded");
} finally {
  server.kill();
}
