import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { command, registry, vcrAppId, vercelApi } from "./lib.mjs";

async function main() {
  const team = getInput("team");
  if (!team.startsWith("team_")) {
    command("warning", `The team input ("${team}") does not look like a Vercel team ID.`);
  }

  const githubOidcToken = await requestGithubOidcToken();
  const vercelToken = await exchangeToken(team, githubOidcToken);
  command("add-mask", vercelToken);
  saveState("accessToken", vercelToken);

  const result = spawnSync("docker", ["login", "--username", team, "--password-stdin", registry], {
    input: Buffer.from(vercelToken),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`docker login exited with status ${result.status}.`);
  }

  saveState("loggedIn", "true");
  console.log(`Logged Docker in to ${registry}.`);
}

function getInput(name) {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  if (!value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value;
}

async function requestGithubOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      'Unable to request the GitHub OIDC token. Add "permissions: id-token: write" to the job.',
    );
  }

  const response = await fetch(requestUrl, {
    headers: { Authorization: `bearer ${requestToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC token request failed with HTTP ${response.status}.`);
  }

  const json = await response.json();
  if (typeof json.value !== "string" || !json.value) {
    throw new Error("GitHub OIDC response did not include a token.");
  }
  return json.value;
}

async function exchangeToken(team, githubOidcToken) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: vcrAppId,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    team_id_or_slug: team,
    subject_token: githubOidcToken,
  });

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${vercelApi}/login/oauth/token`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const json = await response.json().catch(() => ({}));
        if (typeof json.access_token === "string" && json.access_token) {
          return json.access_token;
        }
        lastError = "response did not include an access_token";
        break;
      }

      lastError = `HTTP ${response.status}: ${await response.text().catch(() => "")}`;
      if (response.status !== 429 && response.status < 500) {
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }

  throw new Error(
    "Token exchange with Vercel failed. Check that the team's OIDC policy " +
      `matches this repository and workflow. (${lastError})`,
  );
}

function saveState(name, value) {
  const stateFile = process.env.GITHUB_STATE;
  if (!stateFile) {
    throw new Error("GITHUB_STATE is not available.");
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  if (String(value).includes(delimiter)) {
    throw new Error(`State value for ${name} contains the generated delimiter.`);
  }
  appendFileSync(stateFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

main().catch((error) => {
  command("error", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
