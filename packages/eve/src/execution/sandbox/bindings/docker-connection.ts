import { randomUUID } from "node:crypto";
import { dirname as posixDirname } from "node:path/posix";

import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { stopDockerContainerIfRunning } from "#execution/sandbox/bindings/docker-container.js";
import { setDockerNetworkPolicy } from "#execution/sandbox/bindings/docker-network.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import type { SandboxConnection } from "#public/sandbox/provider.js";

export type DockerSandboxExtensions = Pick<DockerSandboxSession, "setNetworkPolicy">;

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

/**
 * A connection bound to one container's identity rather than its name, so a
 * stale connection's commands, file operations, network policy changes, and
 * stop never reach a later container that reuses the session's name.
 * Deletion is the exception: `onSessionEnd` removes by session name, because
 * it is the single deletion path and must work without an open connection.
 */
export function createDockerConnection(input: {
  readonly cli: DockerCli;
  readonly containerIdentity: string;
}): SandboxConnection<DockerSandboxExtensions> {
  const { cli, containerIdentity } = input;

  async function killSpawnTree(pidFilePath: string): Promise<void> {
    // Best-effort: the container may already be stopped or the process
    // already gone; the script itself exits 0 in those cases.
    await cli
      .run([
        "exec",
        containerIdentity,
        "bash",
        "-c",
        DOCKER_KILL_TREE_SCRIPT,
        "eve-kill-tree",
        pidFilePath,
      ])
      .catch(() => {});
  }

  return {
    extensions: {
      setNetworkPolicy: (policy) => setDockerNetworkPolicy(cli, containerIdentity, policy),
    },
    async spawn(options) {
      const args = ["exec", "-w", options.workingDirectory];
      for (const [key, value] of Object.entries(options.env)) {
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
      args.push(containerIdentity, "bash", "-c", wrapped);

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
    async readFile(options) {
      const quoted = shellQuote(options.path);
      const result = await cli.run(
        [
          "exec",
          containerIdentity,
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
      return result.stdoutBytes;
    },
    async removePath(options) {
      const flags = `${options.recursive === true ? "r" : ""}${options.force === true ? "f" : ""}`;
      const args = [
        "exec",
        containerIdentity,
        "rm",
        ...(flags.length > 0 ? [`-${flags}`] : []),
        "--",
        options.path,
      ];
      const result = await cli.run(args, { signal: options.abortSignal });
      expectDockerSuccess(result, `remove "${options.path}" from sandbox container`);
    },
    stop: () => stopDockerContainerIfRunning(cli, containerIdentity),
    async writeFiles(options) {
      for (const file of options.files) {
        const result = await cli.run(
          [
            "exec",
            "-i",
            containerIdentity,
            "bash",
            "-lc",
            `mkdir -p ${shellQuote(posixDirname(file.path))} && cat > ${shellQuote(file.path)}`,
          ],
          { signal: options.abortSignal, stdin: file.content },
        );
        expectDockerSuccess(result, `write "${file.path}" into sandbox container`);
      }
    },
  };
}
