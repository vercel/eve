import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";

import { defineSandboxProvider, type SandboxConnection } from "#public/sandbox/provider.js";

// A sandbox that is the host directory itself: no copy, no container, no isolation. For a local
// coding agent that edits the repository it runs in, where the person at the keyboard approves
// what it runs. Never the default: a deployed agent must not reach its host's files.

export interface HostSandboxOptions {
  /**
   * The directory commands run in and relative paths resolve from, read each time a step opens
   * the sandbox: `process.cwd()` by default, so a host that changes directory between turns (into
   * a worktree, say) moves the sandbox with it.
   */
  readonly root?: () => string;
  /**
   * Keeps file reads, writes, removals and working directories inside `root`: a path outside it
   * is refused. The check is on the path, so a symlink inside the root can still lead out, and a
   * command's own arguments aren't checked; approvals gate `bash`.
   */
  readonly confine?: boolean;
}

type HostSessionState = { readonly version: 1 };

/** `path`, refused when it resolves outside `root`. */
function insideRoot(root: string, path: string): string {
  const resolved = resolve(root, path);
  const inside = relative(root, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`"${path}" is outside the sandbox's root, ${root}. Use a path inside it.`);
  }
  return resolved;
}

function connect(root: string, confined: boolean): SandboxConnection {
  const checked = (path: string) => (confined ? insideRoot(root, path) : path);
  return {
    async readFile({ path }) {
      try {
        return new Uint8Array(await readFile(checked(path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async removePath({ force, path, recursive }) {
      await rm(checked(path), { force: force === true, recursive: recursive === true });
    },
    async spawn({ command, env, signal, stdin, workingDirectory }) {
      const child = spawn("bash", ["-lc", command], {
        cwd: checked(workingDirectory),
        detached: true,
        env: { ...process.env, ...env },
        stdio: [stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const { stderr, stdout } = child;
      if (stdout === null || stderr === null) throw new Error("bash started without output pipes.");
      // The whole process group, so a pipeline's children die with it.
      const kill = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      signal?.addEventListener("abort", kill, { once: true });
      const exited = new Promise<{ exitCode: number }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code, killedBy) => {
          signal?.removeEventListener("abort", kill);
          resolveExit({ exitCode: code ?? (killedBy === null ? 1 : 128 + 9) });
        });
      });
      return {
        kill: async () => {
          kill();
          await exited.catch(() => undefined);
        },
        pid: child.pid,
        stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
        stdin: child.stdin === null ? undefined : Writable.toWeb(child.stdin),
        stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
        wait: () => exited,
      };
    },
    async stop() {},
    async writeFiles({ files }) {
      for (const file of files) {
        const path = checked(file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
    },
    workspaceRoot: root,
  };
}

/** The host directory as the sandbox. See {@link HostSandboxOptions}. */
export const HostSandbox = defineSandboxProvider({
  name: "host",
  environment: (options: HostSandboxOptions) => {
    const root = options.root ?? (() => process.cwd());
    const confined = options.confine === true;
    // A confined root is compared as the filesystem names it: paths that commands report inside
    // a root reached through a symlink (`pwd` in macOS's `/tmp` prints `/private/tmp`) are in it.
    const open = async () => connect(confined ? await realpath(root()) : root(), confined);
    return {
      // Nothing to build: the directory is already there.
      prepare: async () => null,
      start: async () => ({
        connection: await open(),
        state: { version: 1 } as HostSessionState,
      }),
      resume: open,
      // The files are the host's; ending the session leaves them.
      onSessionEnd: async () => {},
    };
  },
});
