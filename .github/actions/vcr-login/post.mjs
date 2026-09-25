import { spawnSync } from "node:child_process";
import { command, registry, vcrAppId, vercelApi } from "./lib.mjs";

async function post() {
  if (process.env.STATE_loggedIn === "true") {
    const result = spawnSync("docker", ["logout", registry], {
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) {
      command("warning", `Docker logout from ${registry} failed.`);
    }
  }

  const token = process.env.STATE_accessToken;
  if (!token) {
    return;
  }
  command("add-mask", token);

  try {
    const response = await fetch(`${vercelApi}/login/oauth/token/revoke`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: vcrAppId,
        token,
        token_type_hint: "access_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      command(
        "warning",
        `Failed to revoke the Vercel access token (HTTP ${response.status}). It will remain valid until it expires.`,
      );
      return;
    }
    console.log("Revoked the Vercel access token.");
  } catch (error) {
    command(
      "warning",
      `Failed to revoke the Vercel access token (${error instanceof Error ? error.message : error}). It will remain valid until it expires.`,
    );
  }
}

post();
