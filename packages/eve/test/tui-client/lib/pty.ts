import { spawn } from "node:child_process";

/**
 * Relays a child process through a pseudo-terminal of a fixed size, using
 * Python's standard `pty` module so the smoke tests need no native Node
 * dependency. The child sees a real TTY on stdin, stdout, and stderr, exactly
 * like a person's terminal; this process reads what it paints and types into it.
 */
const PTY_BRIDGE = `
import fcntl, os, pty, select, signal, struct, sys, termios
columns, rows = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    os.execvp(sys.argv[3], sys.argv[3:])
signal.signal(signal.SIGTERM, lambda *_: os.killpg(pid, signal.SIGKILL))
stdin, stdout, reading = sys.stdin.fileno(), sys.stdout.fileno(), True
while True:
    ready = select.select([fd] + ([stdin] if reading else []), [], [])[0]
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(stdout, data)
    if stdin in ready:
        data = os.read(stdin, 65536)
        if data:
            os.write(fd, data)
        else:
            reading = False
status = os.waitpid(pid, 0)[1]
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

export interface PseudoTerminal {
  /** Types into the terminal, as raw bytes (`\r` for Enter, `\x1b` for Escape). */
  write(input: string): void;
  /** Called with each chunk the child paints, in order. */
  onData(listener: (chunk: string) => void): void;
  /** Resolves with the child's exit code. */
  readonly exited: Promise<number>;
  /** Kills the child and everything it started. */
  kill(): void;
}

export function spawnInPseudoTerminal(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly columns: number;
  readonly rows: number;
}): PseudoTerminal {
  const child = spawn(
    "python3",
    ["-c", PTY_BRIDGE, String(input.columns), String(input.rows), input.command, ...input.args],
    { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "inherit"] },
  );
  const listeners: Array<(chunk: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const listener of listeners) listener(chunk);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  return {
    write: (text) => {
      child.stdin.write(text);
    },
    onData: (listener) => {
      listeners.push(listener);
    },
    exited,
    kill: () => {
      child.kill("SIGTERM");
    },
  };
}
