import { randomUUID } from "node:crypto";
import { dirname as posixDirname } from "node:path/posix";

import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import { stopDockerContainerIfRunning } from "#execution/sandbox/bindings/docker-container.js";
import { setDockerNetworkPolicy } from "#execution/sandbox/bindings/docker-network.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { withConnectionFastRun } from "#execution/sandbox/internal-shell.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import type { SandboxConnection } from "#public/sandbox/provider.js";

export type DockerSandboxExtensions = Pick<DockerSandboxSession, "setNetworkPolicy">;

const DOCKER_SPAWN_PID_FILE_PREFIX = "/tmp/.eve-sbx-spawn-";

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

export function createDockerConnection(input: {
  readonly cli: DockerCli;
  readonly containerIdentity: string;
}): SandboxConnection<DockerSandboxExtensions> {
  const { cli, containerIdentity } = input;

  async function killSpawnTree(pidFilePath: string): Promise<void> {
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

  const connection: SandboxConnection<DockerSandboxExtensions> = {
    extensions: {
      setNetworkPolicy: (policy) => setDockerNetworkPolicy(cli, containerIdentity, policy),
    },
    async spawn(options) {
      const args = [
        "exec",
        ...(options.stdin === true ? ["-i"] : []),
        "-w",
        options.workingDirectory,
      ];
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
      const pidFilePath = `${DOCKER_SPAWN_PID_FILE_PREFIX}${randomUUID()}.pid`;
      const quotedPidFile = shellQuote(pidFilePath);
      const wrapped =
        `echo "$$" > ${quotedPidFile}; ` +
        `(eval ${shellQuote(options.command)}); ` +
        `status=$?; rm -f ${quotedPidFile}; exit $status`;
      args.push(containerIdentity, "bash", "-lc", wrapped);

      const child = cli.stream(args, { signal: options.signal, stdin: options.stdin });
      options.signal?.addEventListener("abort", () => void killSpawnTree(pidFilePath), {
        once: true,
      });

      return {
        stdin: child.stdin,
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
          "sh",
          "-c",
          `if [ -e ${quoted} ]; then exec cat ${quoted}; else exit 43; fi`,
        ],
        { signal: options.signal },
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
      const result = await cli.run(args, { signal: options.signal });
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
            "sh",
            "-c",
            `mkdir -p ${shellQuote(posixDirname(file.path))} && cat > ${shellQuote(file.path)}`,
          ],
          { signal: options.signal, stdin: file.content },
        );
        expectDockerSuccess(result, `write "${file.path}" into sandbox container`);
      }
    },
  };

  return withConnectionFastRun(connection, async (options) => {
    const args = ["exec", "-w", options.workingDirectory];
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(containerIdentity, "bash", "--noprofile", "--norc", "-c");
    if (options.signal === undefined) {
      const result = await cli.run([...args, options.command]);
      return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
    }
    const pidFilePath = `${DOCKER_SPAWN_PID_FILE_PREFIX}${randomUUID()}.pid`;
    const quotedPidFile = shellQuote(pidFilePath);
    const wrapped =
      `echo "$$" > ${quotedPidFile}; ` +
      `(eval ${shellQuote(options.command)}); ` +
      `status=$?; rm -f ${quotedPidFile}; exit $status`;
    const onAbort = () => void killSpawnTree(pidFilePath);
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await cli.run([...args, wrapped], { signal: options.signal });
      return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }
  });
}
