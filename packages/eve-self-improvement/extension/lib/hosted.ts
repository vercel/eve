import { VercelSandbox } from "eve/sandbox/vercel";
import type { SandboxSession, SandboxNetworkPolicy } from "eve/sandbox";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { credential, type Config } from "./config.js";
import { GitHub } from "./providers.js";
import type { Candidate, Check, HostedRunner } from "./types.js";

export const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
export const repositoryPath = "/workspace/repository";
export const environment = VercelSandbox.environment({ timeout: 1_800_000 });
export type WorkingSandbox = Pick<SandboxSession, "run" | "readBinaryFile"> & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};

export async function openIndependent(
  c: Config,
): Promise<WorkingSandbox & { delete(): Promise<void> }> {
  const sandbox = await Sandbox.create({
    token: await credential(c, "vercel"),
    teamId: c.project.teamId,
    projectId: c.project.projectId,
    runtime: "node26",
    timeout: 1_800_000,
  });
  try {
    const prepared = await sandbox.runCommand("bash", [
      "-lc",
      'sudo mkdir -p /workspace && sudo chown "$(id -u):$(id -g)" /workspace',
    ]);
    if (prepared.exitCode !== 0) throw new Error("Independent sandbox workspace setup failed");
  } catch (error) {
    await sandbox.delete();
    throw error;
  }
  return {
    async run({ command, workingDirectory, env, signal }) {
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", command],
        cwd: workingDirectory ?? "/workspace",
        env,
        signal,
      });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      return { exitCode: result.exitCode, stdout, stderr };
    },
    readBinaryFile: ({ path, signal }) =>
      sandbox.readFileToBuffer({ path, cwd: "/workspace" }, { signal }),
    async setNetworkPolicy(policy) {
      await sandbox.updateNetworkPolicy(policy as NetworkPolicy);
    },
    delete: () => sandbox.delete(),
  };
}

export function installCommand(manifest: any): string {
  const manager = manifest.packageManager;
  if (
    typeof manager !== "string" ||
    !/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+sha\d+\.[a-f0-9]+)?$/.test(manager)
  )
    throw new Error(
      "Pin packageManager to an exact npm, pnpm or Yarn version before autonomous verification",
    );
  const [name, integrityVersion] = manager.split("@");
  const version = integrityVersion.split("+")[0];
  if (name === "npm") return `npx --yes npm@${version} ci`;
  if (name === "pnpm") return `npx --yes pnpm@${version} install --frozen-lockfile`;
  return `corepack yarn@${version} install --immutable`;
}
export function validationCommands(c: Config, baselineManifest: any): string[] {
  if (c.verification.commands) return c.verification.commands;
  const scripts = baselineManifest.scripts ?? {};
  if (!["test", "typecheck", "build"].every((name) => typeof scripts[name] === "string"))
    throw new Error("Configure verification.commands or provide test, typecheck and build scripts");

  return ["typecheck", "test", "build", ...(scripts["build:web"] ? ["build:web"] : [])].map(
    (name) => `export PATH="$PWD/node_modules/.bin:$PATH"\n${scripts[name]}`,
  );
}
export async function checkout(
  c: Config,
  sandbox: Pick<SandboxSession, "run"> & {
    setNetworkPolicy?: (policy: SandboxNetworkPolicy) => Promise<void>;
  },
  sha: string,
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Checkout needs an immutable source SHA");
  const mutable = sandbox as SandboxSession & { setNetworkPolicy?: (policy: any) => Promise<void> };
  if (!mutable.setNetworkPolicy)
    throw new Error("Hosted self-improvement requires Vercel Sandbox firewall credential delivery");
  try {
    const repo = `/${c.repository.owner}/${c.repository.name}.git`.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const authorization = `Basic ${Buffer.from(`x-access-token:${await credential(c, "github")}`).toString("base64")}`;

    await mutable.setNetworkPolicy!({
      allow: {
        "github.com": [
          {
            match: {
              method: ["GET", "POST"],
              path: { regex: `^${repo}/(?:info/refs|git-upload-pack)$` },
            },
            transform: [{ headers: { authorization } }],
          },
        ],
        "*": [],
      },
    });
    const result = await sandbox.run({
      command: [
        "set -e",
        `mkdir -p ${repositoryPath}`,
        `git init ${repositoryPath}`,
        `git -C ${repositoryPath} remote add origin ${quote(`https://github.com/${c.repository.owner}/${c.repository.name}.git`)}`,
        `git -C ${repositoryPath} fetch --depth=2 origin ${sha}`,
        `git -C ${repositoryPath} checkout --detach ${sha}`,
      ].join("\n"),
    });
    if (result.exitCode !== 0)
      throw new Error("Repository checkout failed; credential diagnostics withheld");
  } finally {
    await mutable.setNetworkPolicy("allow-all");
  }
}
export function createHostedRunner(c: Config, git = new GitHub(c)): HostedRunner {
  return {
    checkout: (sandbox, sha) => checkout(c, sandbox, sha),
    async verify(candidate: Candidate) {
      const sandbox = await openIndependent(c);
      try {
        await checkout(c, sandbox, candidate.head);
        const [manifest, baseline] = await Promise.all([
          git.manifest(candidate.head),
          git.manifest(candidate.base),
        ]);
        const commands = [installCommand(manifest), ...validationCommands(c, baseline)];
        const checks: Check[] = [];
        const workingDirectory =
          c.repository.directory === "."
            ? repositoryPath
            : `${repositoryPath}/${c.repository.directory}`;
        for (const [index, command] of commands.entries()) {
          const result = await sandbox.run({ command, workingDirectory });

          checks.push({
            name: index === 0 ? "clean pinned install" : command,
            status: result.exitCode === 0 ? "passed" : "failed",
            reason: `Fresh immutable-head sandbox; exit ${result.exitCode}. Logs remain in private Sandbox observability.`,
          });
          if (result.exitCode !== 0) break;
        }
        return checks;
      } catch {
        return [
          {
            name: "isolated candidate verification",
            status: "failed",
            reason:
              "Sandbox checkout, pinned installation or validation setup failed; inspect private Sandbox logs",
          },
        ];
      } finally {
        await sandbox.delete();
      }
    },
    async deploy(sha: string) {
      if (!/^[a-f0-9]{40}$/.test(sha))
        throw new Error("Release needs an immutable merged source SHA");
      if (!c.release)
        throw new Error(
          "Configure a trusted release.deploy executor outside candidate/build sandboxes",
        );

      await c.release.deploy({ sha, project: c.project, repository: c.repository });
    },
  };
}
