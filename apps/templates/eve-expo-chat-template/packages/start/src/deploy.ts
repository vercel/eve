import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Called by the app's postdeploy hook, with its local environment loaded. */
export async function warmDeployment() {
  const token = process.env.EVE_START_AGENT_TOKEN;
  if (!token)
    throw Error("Run ./scripts/setup.sh to configure EVE_START_AGENT_TOKEN before deploying.");
  const link = JSON.parse(await readFile(".vercel/project.json", "utf8"));
  if (!/^prj_[\w-]+$/.test(link.projectId) || !/^team_[\w-]+$/.test(link.orgId))
    throw Error("Link this app to its Vercel project before deploying.");
  const { stdout } = await execute(
    "vercel",
    ["api", "/v9/projects/" + link.projectId, "--scope", link.orgId, "--raw"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const project = JSON.parse(stdout);
  if (project.id !== link.projectId) throw Error("The linked Vercel project did not match.");
  const deployment = project.targets?.production;
  const alias = deployment?.alias?.find((value: unknown) => typeof value === "string");
  const domain = alias || deployment?.url;
  if (typeof domain !== "string" || !/^[a-zA-Z0-9.-]+$/.test(domain))
    throw Error("No production deployment found for this app.");
  const origin = "https://" + domain;
  const deadline = Date.now() + 240000;
  while (true) {
    const response = await fetch(origin + "/v1/agent/warm", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + token,
        ...(process.env.EVE_START_APP_BYPASS_TOKEN
          ? { "x-vercel-protection-bypass": process.env.EVE_START_APP_BYPASS_TOKEN }
          : {}),
      },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Production aliases can briefly route to the previous build after deployment completes.
      // Warm-up is idempotent; wait for the new route without replaying any chat or browser action.
      if ([404, 502, 503, 504].includes(response.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw Error("Deployment succeeded, but warm-up returned " + response.status + ".");
    }
    const result = (await response.json()) as { database: string; browser: string };
    if (result.database === "ready" && result.browser === "ready") break;
    if (Date.now() >= deadline) throw Error("Deployment succeeded, but warm-up did not finish.");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return origin;
}

export async function afterDeploy() {
  const origin = await warmDeployment();
  console.log("URL: " + origin);
  if (process.env.EVE_APP_PASSWORD) console.log("Password: " + process.env.EVE_APP_PASSWORD);
  else console.log("Password: see agent/extensions/start.ts or EVE_APP_PASSWORD in .env.local.");
}
