import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { SandboxBackend, SandboxProcess, SandboxSession } from "eve/sandbox";

const MAX_BYTES = 16 * 1024 * 1024;
const ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "TERM",
];

function checkSize(bytes: number, operation: string): void {
  if (bytes > MAX_BYTES) throw new Error(`${operation} exceeds 16 MiB`);
}

/**
 * Attach to the task container; the runner owns isolation, networking and deletion.
 * Explicit roots permit local tests, not an isolated host sandbox. No symlinks are
 * created. File paths and cwd map /workspace to root, but shell source is never
 * rewritten: commands (including code__apply_patch's root) must use the actual
 * task directory or relative paths, not literal /workspace paths in shell text.
 * Built-in glob/grep embed paths in shell commands: pass the actual root as path
 * instead of relying on their /workspace default.
 */
export function containerBackend(
  root = process.env.EVE_BENCH_TASK_WORKDIR!,
  { commandTimeoutMs = 120_000 }: { commandTimeoutMs?: number } = {},
): SandboxBackend {
  if (!root?.trim() || !isAbsolute(root))
    throw new Error(
      "EVE_BENCH_TASK_WORKDIR must be an absolute task directory (or pass an explicit test root)",
    );
  if (arguments[0] === undefined && process.env.EVE_BENCH_CONTAINER !== "1")
    throw new Error("The e0 backend requires EVE_BENCH_CONTAINER=1 inside a task container");
  if (
    !Number.isFinite(commandTimeoutMs) ||
    commandTimeoutMs <= 0 ||
    commandTimeoutMs > 2_147_483_647
  )
    throw new Error("commandTimeoutMs must be positive and at most 2147483647");
  root = resolve(root);
  const name = "e0-task-container";
  const children = new Set<SandboxProcess>();
  const skillsHome = () => process.env.HOME && resolve(process.env.HOME, ".agents/skills");
  const within = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);
  const resolvePath = (path: string): string => {
    let target: string;
    if (path === "$HOME" || path.startsWith("$HOME/")) {
      if (!process.env.HOME) throw new Error("HOME is unavailable in the task container");
      target = resolve(process.env.HOME, path.slice(6));
    } else if (path === "/workspace" || path.startsWith("/workspace/")) {
      target = resolve(root, path === "/workspace" ? "." : path.slice(11));
    } else {
      target = resolve(root, path);
    }
    const skills = skillsHome();
    if (!within(root, target) && !(skills && within(skills, target))) {
      throw new Error("Sandbox paths must stay inside the task workspace or seeded skills");
    }
    return target;
  };
  const rejectSymlinkPath = async (target: string) => {
    const base = within(root, target) ? root : skillsHome()!;
    let current = base;
    for (const component of relative(base, target).split(sep).filter(Boolean)) {
      current = resolve(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error("Sandbox file operations do not follow symbolic links");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  };
  const stop = async () => {
    await Promise.all([...children].map((child) => child.kill()));
  };
  const session: SandboxSession & { readonly description: string } = {
    id: `${name}:${root}`,
    description: `Task container. Work in ${JSON.stringify(root)}; use this actual root for code__apply_patch. File operations and cwd map /workspace here, but shell command text does not. Use relative paths or the actual task directory in bash. Always pass the actual task directory as glob/grep's path; their /workspace default is not remapped. Skill files are under $HOME/.agents/skills.`,
    resolvePath,
    async spawn({ command, workingDirectory, env = {}, abortSignal }) {
      abortSignal?.throwIfAborted();
      const shellEnv: NodeJS.ProcessEnv = {};
      for (const key of ENV_KEYS) {
        if (process.env[key] !== undefined) shellEnv[key] = process.env[key];
      }
      // Neither inherit credentials nor let login profiles reload production env.
      const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        cwd: resolvePath(workingDirectory ?? "."),
        env: { ...shellEnv, ...env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let killed = false;
      let timedOut = false;
      let failure: Error | undefined;
      let bytes = 0;
      const killGroup = () => {
        if (settled || killed || child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        killed = true;
      };
      const abort = () => killGroup();
      abortSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, commandTimeoutMs);
      const stream = (source: Readable) => {
        let closed = false;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            source.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > MAX_BYTES && !failure) {
                failure = new Error("Command output exceeds 16 MiB");
                killGroup();
              }
              if (closed) return;
              if (failure) {
                closed = true;
                controller.error(failure);
              } else controller.enqueue(chunk);
            });
            source.once("error", (error) => {
              failure ??= error;
              killGroup();
              if (!closed) {
                closed = true;
                controller.error(error);
              }
            });
            source.once("close", () => {
              if (!closed) {
                closed = true;
                controller.close();
              }
            });
          },
          cancel() {
            closed = true;
            killGroup();
          },
        });
      };
      const stdout = stream(child.stdout);
      const stderr = stream(child.stderr);
      // A shell can exit while a background descendant has redirected its pipes.
      // Kill the group on exit as well as timeout, before dropping its PID.
      child.once("exit", killGroup);
      const completed = new Promise<{ exitCode: number }>((resolve, reject) => {
        child.once("error", (error) => {
          failure ??= error;
        });
        child.once("close", (code) => {
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener("abort", abort);
          children.delete(handle);
          if (abortSignal?.aborted) reject(abortSignal.reason);
          else if (failure) reject(failure);
          else resolve({ exitCode: timedOut ? 124 : (code ?? 137) });
        });
      });
      // Stream consumers may wait only after draining output, or never wait at all.
      void completed.catch(() => {});
      const handle: SandboxProcess = {
        pid: child.pid,
        stdout,
        stderr,
        wait: () => completed,
        async kill() {
          killGroup();
          await completed.catch(() => {});
        },
      };
      children.add(handle);
      if (abortSignal?.aborted) killGroup();
      return handle;
    },
    async run(input) {
      const child = await session.spawn(input);
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString("utf8");
      };
      try {
        const [stdout, stderr, result] = await Promise.all([
          collect(child.stdout),
          collect(child.stderr),
          child.wait(),
        ]);
        return {
          ...result,
          stdout,
          stderr:
            result.exitCode === 124
              ? `${stderr}\nCommand ended with exit 124 (timeout limit ${commandTimeoutMs}ms); its process group was stopped.\n`
              : stderr,
        };
      } finally {
        await child.kill();
      }
    },
    async readBinaryFile({ path, abortSignal }) {
      abortSignal?.throwIfAborted();
      let file;
      try {
        // Nonblocking open + regular-file check avoid hangs on FIFOs/devices.
        const target = resolvePath(path);
        await rejectSymlinkPath(target);
        file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Only regular files can be read");
        checkSize(stat.size, "File read");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          abortSignal?.throwIfAborted();
          const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - bytes));
          const { bytesRead } = await file.read(buffer);
          abortSignal?.throwIfAborted();
          if (bytesRead === 0) return Buffer.concat(chunks);
          bytes += bytesRead;
          checkSize(bytes, "File read");
          chunks.push(buffer.subarray(0, bytesRead));
        }
      } finally {
        await file.close();
      }
    },
    async readFile(options) {
      const bytes = await session.readBinaryFile(options);
      return bytes === null
        ? null
        : new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
    },
    async readTextFile({ encoding = "utf-8", startLine, endLine, ...options }) {
      if (
        (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) ||
        (endLine !== undefined && (!Number.isInteger(endLine) || endLine < (startLine ?? 1)))
      )
        throw new Error("Invalid 1-based line range");
      const bytes = await session.readBinaryFile(options);
      if (bytes === null) return null;
      const text =
        encoding === "utf-8" || encoding === "utf8"
          ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          : Buffer.from(bytes).toString(bufferEncoding(encoding));
      return startLine === undefined && endLine === undefined
        ? text
        : text
            .split("\n")
            .slice((startLine ?? 1) - 1, endLine)
            .join("\n");
    },
    async writeBinaryFile({ path, content, abortSignal }) {
      abortSignal?.throwIfAborted();
      checkSize(content.byteLength, "File write");
      const target = resolvePath(path);
      await rejectSymlinkPath(target);
      await mkdir(dirname(target), { recursive: true });
      await rejectSymlinkPath(target);
      abortSignal?.throwIfAborted();
      const file = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK,
      );
      try {
        if (!(await file.stat()).isFile()) throw new Error("Only regular files can be written");
        abortSignal?.throwIfAborted();
        await file.truncate(0);
        await file.writeFile(content, { signal: abortSignal });
      } finally {
        await file.close();
      }
    },
    async writeTextFile({ content, encoding = "utf8", ...options }) {
      const codec = bufferEncoding(encoding);
      checkSize(Buffer.byteLength(content, codec), "File write");
      await session.writeBinaryFile({ ...options, content: Buffer.from(content, codec) });
    },
    async writeFile({ content, ...options }) {
      options.abortSignal?.throwIfAborted();
      const reader = content.getReader();
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          options.abortSignal?.throwIfAborted();
          const next = await reader.read();
          options.abortSignal?.throwIfAborted();
          if (next.done) break;
          bytes += next.value.byteLength;
          checkSize(bytes, "File write");
          if (next.value.byteLength) chunks.push(Buffer.from(next.value));
        }
        await session.writeBinaryFile({ ...options, content: Buffer.concat(chunks) });
      } finally {
        options.abortSignal?.removeEventListener("abort", abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    async removePath({ path, recursive = false, force = false, abortSignal }) {
      abortSignal?.throwIfAborted();
      const target = resolvePath(path);
      await rejectSymlinkPath(target);
      await rm(target, { recursive, force });
    },
    async setNetworkPolicy(policy) {
      if (policy !== "allow-all")
        throw new Error(
          "The runner owns network policy; this backend cannot change the firewall or broker credentials",
        );
    },
  };
  return {
    name,
    async prewarm({ seedFiles, bootstrap }) {
      if (bootstrap)
        throw new Error("Production sandbox bootstrap must not run in the task container");
      for (const file of seedFiles) {
        const path = resolvePath(file.path);
        const skills = skillsHome();
        if (!(path.startsWith(`${root}/`) || (skills && path.startsWith(`${skills}/`))))
          throw new Error("Unexpected seed path: use the task workspace or $HOME/.agents/skills");
        checkSize(
          typeof file.content === "string"
            ? Buffer.byteLength(file.content)
            : file.content.byteLength,
          "Seed file",
        );
      }
      await mkdir(root, { recursive: true });
      for (const file of seedFiles) {
        await session.writeBinaryFile({
          path: file.path,
          content: typeof file.content === "string" ? Buffer.from(file.content) : file.content,
        });
      }
      return { reused: false };
    },
    async create({ sessionKey }) {
      await mkdir(root, { recursive: true });
      const liveSession = { ...session, id: sessionKey };
      return {
        session: liveSession,
        useSessionFn: async () => liveSession,
        captureState: async () => ({ backendName: name, metadata: {}, sessionKey }),
        stop,
        shutdown: stop,
      };
    },
  };
}

function bufferEncoding(encoding: string): BufferEncoding {
  if (!Buffer.isEncoding(encoding)) throw new Error(`Unsupported encoding: ${encoding}`);
  return encoding;
}
