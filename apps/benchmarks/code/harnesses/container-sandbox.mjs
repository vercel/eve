import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

export const TASK_CONTAINER_PROVIDER_NAME = "code-bench-container";

const PREPARE_HOME = "/__code_bench_prepare_home__";
const connections = new Map();
const starts = new Map();

export function taskContainerEnvironment(options = {}) {
  const { root, workspaceAlias = "/workspace" } = options;

  const taskRoot = () => {
    if (root !== undefined) return root;
    if (process.env.CODE_BENCH_TASK_CONTAINER !== "1") {
      throw new Error("The benchmark sandbox may start only inside a task container");
    }
    const workdir = process.env.CODE_BENCH_TASK_WORKDIR;
    if (!workdir || !isAbsolute(workdir)) {
      throw new Error("CODE_BENCH_TASK_WORKDIR must be the absolute task working directory");
    }
    return workdir;
  };

  const sessionKey = (ctx) =>
    join(
      ctx.storagePath,
      TASK_CONTAINER_PROVIDER_NAME,
      createHash("sha256").update(ctx.session.id).digest("hex"),
    );

  const open = async (ctx) => {
    const id = sessionKey(ctx);
    if (!connections.has(id)) {
      const pending = openTaskContainer(
        taskRoot(),
        root === undefined ? workspaceAlias : undefined,
      );
      connections.set(id, pending);
      pending.catch(() => connections.delete(id));
    }
    return connections.get(id);
  };

  return {
    async prepare(ctx) {
      const files = [];
      await ctx.populate({
        workspaceRoot: "/workspace",
        async spawn({ command }) {
          if (command !== `printf '%s\\n' "$HOME"`) {
            throw new Error(
              "The benchmark sandbox cannot execute prepare commands on the build host",
            );
          }
          return {
            stdout: byteStream(Buffer.from(`${PREPARE_HOME}\n`)),
            stderr: byteStream(new Uint8Array()),
            wait: async () => ({ exitCode: 0 }),
            kill: async () => {},
          };
        },
        async writeFiles({ files: batch }) {
          for (const file of batch) {
            files.push({
              path: file.path.startsWith(`${PREPARE_HOME}/`)
                ? `$HOME/${file.path.slice(PREPARE_HOME.length + 1)}`
                : file.path,
              base64: Buffer.from(file.content).toString("base64"),
            });
          }
        },
        async readFile() {
          throw new Error("Build-time sandbox reads are not supported");
        },
        async removePath() {
          throw new Error("Build-time sandbox removals are not supported");
        },
        async stop() {},
      });
      return { version: 1, files };
    },

    async start(ctx, _liveOptions, artifact) {
      const id = sessionKey(ctx);
      if (!starts.has(id)) {
        const pending = (async () => {
          const connection = await open(ctx);
          const marker = join(id, "populated");
          if (!existsSync(marker)) {
            await writeArtifactFiles(connection, artifact);
            await mkdir(id, { recursive: true });
            await writeFile(marker, "");
          }
          return { connection, state: { version: 1 } };
        })();
        starts.set(id, pending);
        pending.finally(() => starts.delete(id)).catch(() => {});
      }
      return starts.get(id);
    },

    async resume(ctx) {
      await stat(taskRoot());
      return open(ctx);
    },

    async onSessionEnd(ctx, _state, { signal } = {}) {
      signal?.throwIfAborted();
      const id = sessionKey(ctx);
      await starts.get(id);
      const connection = await connections.get(id);
      await connection?.stop();
      connections.delete(id);
    },
  };
}

function byteStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function writeArtifactFiles(connection, artifact) {
  const homeDir = process.env.HOME ?? "/root";
  const files = (artifact?.files ?? []).map((file) => {
    const isHome = file.path.startsWith("$HOME/");
    const path = isHome ? resolve(homeDir, file.path.slice(6)) : resolve(file.path);
    const allowedRoot = isHome ? resolve(homeDir, ".agents/skills") : "/workspace";
    if (!path.startsWith(`${allowedRoot}/`)) {
      throw new Error(`Unexpected sandbox resource path: ${file.path}`);
    }
    return { path, content: Buffer.from(file.base64, "base64") };
  });
  await connection.writeFiles({ files, exclusive: true });
}

async function openTaskContainer(root, workspaceAlias) {
  await mkdir(root, { recursive: true });
  if (workspaceAlias) {
    try {
      if ((await realpath(workspaceAlias)) !== (await realpath(root))) {
        throw new Error(
          `/workspace must refer to the benchmark task root at ${root}, but it already exists elsewhere`,
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await symlink(root, workspaceAlias);
    }
  }

  const children = new Set();
  const taskEnv = taskCommandEnv();
  const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const resolvePath = (path) =>
    resolve(
      root,
      path === "/workspace" ? "." : path.startsWith("/workspace/") ? path.slice(11) : path,
    );

  // Only invoked on explicit stop() or onSessionEnd(). `close` is intentionally omitted so
  // per-step `ensureSandboxAccess.release()` calls never kill concurrent commands across
  // subagents or background bash-job poll steps.
  const stop = async () => {
    for (const child of Array.from(children)) await child.kill();
  };

  return {
    workspaceRoot: "/workspace",
    async spawn({ command, workingDirectory, env = {}, signal, stdin = false }) {
      signal?.throwIfAborted();
      const child = spawn(shell, ["-c", command], {
        cwd: resolvePath(workingDirectory ?? "/workspace"),
        env: { ...taskEnv, ...env },
        detached: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });

      let settled = false;
      const kill = async () => {
        if (settled || !child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      };
      const abort = () => {
        void kill();
      };
      signal?.addEventListener("abort", abort, { once: true });

      const completed = new Promise((resolveDone, rejectDone) => {
        child.once("error", rejectDone);
        child.once("close", (code) => {
          if (signal?.aborted) rejectDone(signal.reason);
          else resolveDone({ exitCode: code ?? 137 });
        });
      }).finally(() => {
        settled = true;
        signal?.removeEventListener("abort", abort);
        children.delete(handle);
      });
      completed.catch(() => {});

      const handle = {
        pid: child.pid,
        ...(stdin && child.stdin ? { stdin: Writable.toWeb(child.stdin) } : {}),
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        wait: () => completed,
        kill,
      };
      children.add(handle);
      if (signal?.aborted) await kill();
      return handle;
    },

    async readFile({ path, signal }) {
      try {
        return await readFile(resolvePath(path), { signal });
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },

    async writeFiles({ files, signal, exclusive = false }) {
      for (const { path, content } of files) {
        signal?.throwIfAborted();
        const target = resolvePath(path);
        await mkdir(dirname(target), { recursive: true });
        try {
          await writeFile(target, content, { signal, flag: exclusive ? "wx" : "w" });
        } catch (error) {
          if (!exclusive || error.code !== "EEXIST") throw error;
        }
      }
    },

    async removePath({ path, recursive = false, force = false, signal }) {
      signal?.throwIfAborted();
      await rm(resolvePath(path), { recursive, force });
    },

    stop,
    extensions: {
      description: `Benchmark task container. Work in ${root}; /workspace paths resolve to the same task workspace through file tools.`,
    },
  };
}

function taskCommandEnv() {
  const snapshot = process.env.CODE_BENCH_TASK_ENV;
  if (!snapshot) return { ...process.env };
  return JSON.parse(snapshot);
}
