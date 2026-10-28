import { setupProgress } from "./progress.ts";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
const execute = promisify(execFile);
export const START_MOUNT =
  "import start from '@eve-start/eve';\n\nexport default start({\n  password: process.env.EVE_APP_PASSWORD,\n});\n";
export const AFTER_DEPLOY = `node --env-file-if-exists=.env.local --input-type=module -e "import('@eve-start/eve/deploy').then(({afterDeploy})=>afterDeploy())"`;
export function configureDeployPassword(manifest: { scripts?: Record<string, string> }) {
  const scripts = (manifest.scripts ||= {});
  const hook = scripts.postdeploy || "";
  scripts.postdeploy = hook.includes(AFTER_DEPLOY)
    ? hook
    : hook
      ? hook + " && " + AFTER_DEPLOY
      : AFTER_DEPLOY;
}
export const START_HOMEPAGE = `import { defineChannel, GET, HEAD } from 'eve/channels';

const redirect = async () =>
  new Response(null, {
    status: 302,
    headers: { Location: '/start', 'Cache-Control': 'no-store' },
  });

export default defineChannel({ routes: [GET('/', redirect), HEAD('/', redirect)] });
`;
export async function configureHomepage(root: string, enabled = true) {
  const file = join(root, "agent/channels/home.ts");
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (enabled && existing === undefined) {
    await mkdir(join(root, "agent/channels"), { recursive: true });
    await writeFile(file, START_HOMEPAGE, { flag: "wx" });
  } else if (!enabled && existing === START_HOMEPAGE) await rm(file);
}
export function mergeEnv(source: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const encoded = ["'" + value + "'", '"' + value + '"', "`" + value + "`", value].find(
      (candidate) => parseEnv("VALUE=" + candidate).VALUE === value,
    );
    if (encoded === undefined) throw Error("Cannot safely write " + key + " to .env.local.");
    const line = key + "=" + encoded,
      pattern = new RegExp("^" + key + "=.*$", "m");
    source = pattern.test(source)
      ? source.replace(pattern, () => line)
      : source.trimEnd() + "\n" + line + "\n";
  }
  return source.trimStart().trimEnd() + "\n";
}
export type InitOptions = {
  scope?: string;
  skipBrowser?: boolean;
  localOnly?: boolean;
  name?: string;
};
export async function initialize(options: InitOptions = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "eve-expo-setup-"));
  await chmod(temporary, 0o700);
  const progress = setupProgress(),
    log = progress.step;
  let scope = options.scope;
  const vercel = async (args: string[]) => {
    try {
      return (
        await execute("vercel", [...args, ...(scope ? ["--scope", scope] : [])], {
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout;
    } catch {
      throw Error(
        "Vercel could not complete " +
          args[0] +
          ". Run vercel login, link the intended project with vercel link, and check project permissions. Setup preserves existing credentials.",
      );
    }
  };
  const api = async (path: string, body?: unknown) => {
    const args = ["api", path];
    if (body !== undefined) {
      const file = join(temporary, "request.json");
      await writeFile(file, JSON.stringify(body), { mode: 0o600 });
      args.push("-X", "PATCH", "--input", file);
    }
    return JSON.parse(await vercel(args));
  };
  try {
    let source = "";
    try {
      source = await readFile(".env.local", "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let linked: { projectId: string; orgId: string };
    try {
      linked = JSON.parse(await readFile(".vercel/project.json", "utf8"));
    } catch {
      throw Error("Run vercel login and vercel link, then rerun ./scripts/setup.sh.");
    }
    scope ||= linked.orgId;
    log("Reading the linked Vercel project and deployment protection…");
    const project = await api("/v9/projects/" + encodeURIComponent(linked.projectId));
    const environmentFile = join(temporary, "project.env");
    await vercel(["env", "pull", environmentFile, "--yes"]);
    await chmod(environmentFile, 0o600);
    const pulled = parseEnv(await readFile(environmentFile, "utf8"));
    const env = { ...pulled, ...process.env, ...parseEnv(source) };
    const password = env.EVE_APP_PASSWORD || randomBytes(6).toString("base64url");
    const agentToken = env.EVE_START_AGENT_TOKEN || randomBytes(32).toString("base64url");
    if (password.length < 8)
      throw Error("EVE_APP_PASSWORD must contain at least eight characters.");
    if (agentToken.length < 32)
      throw Error(
        "Restore a strong EVE_START_AGENT_TOKEN before setup; existing storage has not been changed.",
      );
    if (pulled.EVE_START_AGENT_TOKEN && pulled.EVE_START_AGENT_TOKEN !== agentToken)
      throw Error(
        "Local and deployed agent credentials differ. Restore the deployed EVE_START_AGENT_TOKEN before setup; existing storage has not been changed.",
      );
    if (pulled.EVE_START_AGENT_ID && env.EVE_START_AGENT_ID !== pulled.EVE_START_AGENT_ID)
      throw Error(
        "Local and deployed agent identities differ. Restore EVE_START_AGENT_ID before setup.",
      );
    const agentId =
      env.EVE_START_AGENT_ID ||
      "app-" + createHash("sha256").update(agentToken).digest("hex").slice(0, 32);
    const databaseUrl = env.DATABASE_URL;
    const values: Record<string, string> = {
      EVE_APP_PASSWORD: password,
      EVE_START_AGENT_TOKEN: agentToken,
      EVE_START_AGENT_ID: agentId,
      EVE_START_NAME: options.name || env.EVE_START_NAME || project.name,
    };
    if (databaseUrl) values.DATABASE_URL = databaseUrl;
    if (
      project.passport ||
      project.ssoProtection ||
      project.passwordProtection ||
      project.trustedIps
    ) {
      const pick = (entries: Record<string, { scope: string }> = {}) =>
        Object.entries(entries).find(([, value]) => value.scope === "automation-bypass")?.[0];
      let bypass = pick(project.protectionBypass);
      if (!bypass) {
        log("Creating the required automation bypass…");
        bypass = pick(
          (await api("/v1/projects/" + encodeURIComponent(project.id) + "/protection-bypass", {}))
            .protectionBypass,
        );
      }
      if (!bypass)
        throw Error(
          "A project administrator must enable Protection Bypass for Automation, then rerun ./scripts/setup.sh.",
        );
      values.EVE_START_APP_BYPASS_TOKEN = bypass;
    }
    // Persist identity before provisioning so interrupted setup can be safely resumed.
    await writeFile(".env.local", mergeEnv(source, values), { mode: 0o600 });
    await chmod(".env.local", 0o600);
    let ignored = "";
    try {
      ignored = await readFile(".gitignore", "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!ignored.split("\n").includes(".env.local"))
      await writeFile(".gitignore", ignored + "\n.env.local\n");
    log("Configuring the agent…");
    await mkdir("agent/extensions", { recursive: true });
    try {
      await writeFile("agent/extensions/start.ts", START_MOUNT, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      log("Preserving agent/extensions/start.ts.");
    }
    const require = createRequire(resolve("package.json"));
    const mountedStart = await import(pathToFileURL(require.resolve("@eve-start/eve")).href);
    await import(pathToFileURL(resolve("agent/extensions/start.ts")).href);
    await configureHomepage(process.cwd(), mountedStart.default.config.redirectHomepage);
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    configureDeployPassword(manifest);
    await writeFile("package.json", JSON.stringify(manifest, null, 2) + "\n");
    if (!databaseUrl || !options.skipBrowser) {
      if (!pulled.VERCEL_OIDC_TOKEN)
        throw Error(
          "Storage and browser provisioning require the linked project’s Vercel identity. Run vercel env pull and retry.",
        );
      process.env.VERCEL_OIDC_TOKEN = pulled.VERCEL_OIDC_TOKEN;
      const provision = await import(
        pathToFileURL(require.resolve("@eve-start/eve/provision")).href
      );
      if (!databaseUrl)
        await provision.prepareAppDatabase({ secret: agentToken, log, output: progress.output });
      if (!options.skipBrowser)
        await provision.prepareBrowserImage({
          agentId,
          databaseUrl,
          agentToken,
          log,
          output: progress.output,
        });
    }
    if (!options.localOnly) {
      log("Installing credentials in the linked Vercel project…");
      for (const [key, value] of Object.entries(values)) {
        const file = join(temporary, "environment.json");
        await writeFile(
          file,
          JSON.stringify({
            key,
            value,
            type: "encrypted",
            target: ["production", "preview", "development"],
          }),
          { mode: 0o600 },
        );
        await vercel([
          "api",
          "/v10/projects/" + encodeURIComponent(project.id) + "/env?upsert=true",
          "-X",
          "POST",
          "--input",
          file,
          "--silent",
        ]);
      }
    }
    progress.stop();
    log("Setup complete. Generated secrets are in .env.local. Run pnpm deploy, then open /start.");
  } finally {
    progress.stop();
    await rm(temporary, { recursive: true, force: true });
  }
}
