import { randomUUID } from "node:crypto";
import { dirname as posixDirname } from "node:path/posix";

import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { resolveWorkspacePath } from "#execution/sandbox/bindings/local-backend-utils.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type {
  InternalSandboxSession,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";

const DOCKER_SPAWN_PID_FILE_PREFIX = "/tmp/.eve-sbx-spawn-";

/**
 * Recursive in-container process-tree kill, written against `/proc`
 * directly so it only depends on bash (already a hard requirement) and
 * not on `pgrep`/`ps` being present in the image. Receives the pid
 * file path as `$1`, kills children depth-first, then the recorded
 * wrapper pid. Double-forked daemons that reparented to PID 1 are out
 * of reach by design — they no longer belong to the spawn's tree.
 */
const DOCKER_KILL_TREE_SCRIPT = [
  'pid_file="$1"',
  'target="$(cat "$pid_file" 2>/dev/null)" || exit 0',
  '[ -n "$target" ] || exit 0',
  "kill_tree() {",
  '  local parent="$1" dir child ppid line',
  "  for dir in /proc/[0-9]*; do",
  '    child="${dir#/proc/}"',
  '    ppid=""',
  "    while IFS= read -r line; do",
  '      case "$line" in',
  '        PPid:*) ppid="${line#PPid:}"; ppid="${ppid//[^0-9]/}"; break ;;',
  "      esac",
  '    done < "$dir/status" 2>/dev/null',
  '    [ "$ppid" = "$parent" ] && kill_tree "$child"',
  "  done",
  '  kill -9 "$parent" 2>/dev/null',
  "}",
  'kill_tree "$target"',
  'rm -f "$pid_file"',
  "exit 0",
].join("\n");

export function createDockerInternalSession(input: {
  readonly cli: DockerCli;
  readonly containerName: string;
  readonly id: string;
}): InternalSandboxSession {
  const { cli, containerName } = input;

  async function killSpawnTree(pidFilePath: string): Promise<void> {
    // Best-effort: the container may already be stopped or the process
    // already gone; the script itself exits 0 in those cases.
    await cli
      .run([
        "exec",
        containerName,
        "bash",
        "-c",
        DOCKER_KILL_TREE_SCRIPT,
        "eve-kill-tree",
        pidFilePath,
      ])
      .catch(() => {});
  }

  return {
    id: input.id,
    resolvePath: resolveWorkspacePath,
    async spawn(options: SandboxSpawnOptions) {
      const args = ["exec", "-w", resolveWorkspacePath(options.workingDirectory ?? WORKSPACE_ROOT)];
      for (const [key, value] of Object.entries(options.env ?? {})) {
        args.push("-e", `${key}=${value}`);
      }
      // `docker exec` cannot deliver signals to the exec'd process, so
      // killing the local CLI client alone would leak the command
      // inside the long-lived container. The wrapper records its own
      // pid (the parent of the whole spawn tree) into a per-spawn file
      // that `kill()` and abort feed to DOCKER_KILL_TREE_SCRIPT; on
      // natural exit it removes the file and preserves the inner
      // command's exit code.
      const pidFilePath = `${DOCKER_SPAWN_PID_FILE_PREFIX}${randomUUID()}.pid`;
      const wrapped =
        `echo "$$" > ${shellQuote(pidFilePath)}; ` +
        `bash -lc ${shellQuote(options.command)}; ` +
        `status=$?; rm -f ${shellQuote(pidFilePath)}; exit $status`;
      args.push(containerName, "bash", "-c", wrapped);

      const child = cli.stream(args, { signal: options.abortSignal });
      options.abortSignal?.addEventListener("abort", () => void killSpawnTree(pidFilePath), {
        once: true,
      });

      return {
        stdout: child.stdout,
        stderr: child.stderr,
        async wait() {
          return await child.wait();
        },
        async kill() {
          await killSpawnTree(pidFilePath);
          await child.kill();
        },
      };
    },
    async readFile(options: SandboxReadFileOptions) {
      const quoted = shellQuote(options.path);
      const result = await cli.run(
        [
          "exec",
          containerName,
          "bash",
          "-lc",
          // A sentinel exit code distinguishes "missing" from real read
          // failures (permissions, directories) which must surface.
          `if [ -e ${quoted} ]; then exec cat ${quoted}; else exit 43; fi`,
        ],
        { signal: options.abortSignal },
      );
      if (result.exitCode === 43) {
        return null;
      }
      expectDockerSuccess(result, `read "${options.path}" from sandbox container`);
      return bufferToStream(result.stdoutBytes);
    },
    async removePath(options: SandboxRemovePathOptions) {
      const flags = `${options.recursive === true ? "r" : ""}${options.force === true ? "f" : ""}`;
      const args = [
        "exec",
        containerName,
        "rm",
        ...(flags.length > 0 ? [`-${flags}`] : []),
        "--",
        options.path,
      ];
      const result = await cli.run(args, { signal: options.abortSignal });
      expectDockerSuccess(result, `remove "${options.path}" from sandbox container`);
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      const result = await cli.run(
        [
          "exec",
          "-i",
          containerName,
          "bash",
          "-lc",
          `mkdir -p ${shellQuote(posixDirname(options.path))} && cat > ${shellQuote(options.path)}`,
        ],
        { signal: options.abortSignal, stdin: bytes },
      );
      expectDockerSuccess(result, `write "${options.path}" into sandbox container`);
    },
  };
}
