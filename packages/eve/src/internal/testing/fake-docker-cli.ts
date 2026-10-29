import type {
  DockerCli,
  DockerCommandResult,
  DockerProcess,
} from "#execution/sandbox/bindings/docker-cli.js";
import { bufferToStream } from "#execution/sandbox/stream-utils.js";

export type FakeResponse = Partial<DockerCommandResult> & {
  readonly streamStdout?: string;
};

export interface FakeDockerCall {
  readonly args: readonly string[];
  readonly stdin?: Buffer;
}

export function createFakeDockerCli(
  respond: (args: readonly string[]) => FakeResponse | undefined = () => undefined,
): { calls: FakeDockerCall[]; cli: DockerCli; killedStreams: (readonly string[])[] } {
  const calls: FakeDockerCall[] = [];
  const createdContainerNames = new Set<string>();
  const killedStreams: (readonly string[])[] = [];

  function resolve(args: readonly string[]): DockerCommandResult {
    let partial = respond(args) ?? {};
    if (args[0] === "container" && args[1] === "inspect" && args[3] === "{{.Id}}") {
      const containerName = args.at(-1) ?? "unknown";
      if (createdContainerNames.has(containerName) || (partial.exitCode ?? 0) === 0) {
        partial = { ...partial, exitCode: 0, stdout: fakeDockerContainerIdentity(containerName) };
      }
    }
    const stdout = partial.stdout ?? "";
    const result = {
      exitCode: partial.exitCode ?? 0,
      stderr: partial.stderr ?? "",
      stdout,
      stdoutBytes: partial.stdoutBytes ?? Buffer.from(stdout, "utf8"),
    };
    if (args[0] === "run" && result.exitCode === 0) {
      const nameIndex = args.indexOf("--name");
      const containerName = nameIndex === -1 ? undefined : args[nameIndex + 1];
      if (containerName !== undefined) createdContainerNames.add(containerName);
    }
    return result;
  }

  return {
    calls,
    killedStreams,
    cli: {
      async run(args, options) {
        calls.push({
          args: [...args],
          stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin),
        });
        return resolve(args);
      },
      stream(args): DockerProcess {
        calls.push({ args: [...args] });
        const partial = respond(args) ?? {};
        return {
          stdout: bufferToStream(Buffer.from(partial.streamStdout ?? "", "utf8")),
          stderr: bufferToStream(Buffer.alloc(0)),
          async wait() {
            return { exitCode: partial.exitCode ?? 0 };
          },
          async kill() {
            killedStreams.push([...args]);
          },
        };
      },
    },
  };
}

export function findCall(
  calls: readonly FakeDockerCall[],
  predicate: (args: readonly string[]) => boolean,
): FakeDockerCall | undefined {
  return calls.find((call) => predicate(call.args));
}

export function isContainerInspect(args: readonly string[]): boolean {
  return args[0] === "container" && args[1] === "inspect";
}

export function fakeDockerContainerIdentity(containerName: string): string {
  return `sha256:${containerName}`;
}
