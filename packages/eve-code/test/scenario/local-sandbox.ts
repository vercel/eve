import { execFile, spawn as spawnProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { SandboxSession } from "eve/sandbox";

const execFileAsync = promisify(execFile);

export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Eve Test",
  GIT_AUTHOR_EMAIL: "eve@example.com",
  GIT_COMMITTER_NAME: "Eve Test",
  GIT_COMMITTER_EMAIL: "eve@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, env: GIT_ENV });
  return stdout.trim();
}

export async function initRepo(
  dir: string,
  files: Readonly<Record<string, string>>,
  remote?: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  if (remote !== undefined) await git(dir, ["remote", "add", "origin", remote]);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
  return await git(dir, ["rev-parse", "HEAD"]);
}

export function createLocalSandbox(root: string, envOverrides: NodeJS.ProcessEnv = {}) {
  const commands: string[] = [];
  const resolveCwd = (workingDirectory: string | undefined) =>
    workingDirectory === undefined
      ? root
      : isAbsolute(workingDirectory)
        ? workingDirectory
        : join(root, workingDirectory);
  const sandbox: Pick<SandboxSession, "resolvePath" | "run" | "spawn"> = {
    resolvePath: (path) => (isAbsolute(path) ? path : join(root, path)),
    async run({ command, workingDirectory, env }) {
      commands.push(command);
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
          cwd: resolveCwd(workingDirectory),
          env: { ...GIT_ENV, ...envOverrides, ...env },
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        };
      }
    },
    async spawn({ command, workingDirectory, env }) {
      commands.push(command);
      const child = spawnProcess("bash", ["-c", command], {
        cwd: resolveCwd(workingDirectory),
        env: { ...GIT_ENV, ...envOverrides, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
        let settled = false;
        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode: code });
        };
        child.once("error", () => finish(1));
        child.once("close", (code) => finish(typeof code === "number" ? code : 1));
      });
      return {
        ...(child.pid !== undefined && { pid: child.pid }),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exitPromise,
        async kill() {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              if (process.platform === "win32") child.kill();
              else child.kill("SIGKILL");
            } catch {}
          }
          child.stdout.destroy();
          child.stderr.destroy();
          await exitPromise;
        },
      };
    },
  };
  return { sandbox, commands };
}
