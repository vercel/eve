const MAX_STREAM_CHARS = 8_000;

type CommandOutput = {
  readonly stderr: string;
  readonly stdout: string;
};

function boundedStream(name: "stderr" | "stdout", output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_STREAM_CHARS) return `${name}:\n${trimmed}`;
  return `${name} (last ${MAX_STREAM_CHARS} characters):\n${trimmed.slice(-MAX_STREAM_CHARS)}`;
}

/** Preserve useful output from failed sandbox commands without flooding build logs. */
export function commandFailureDetail(result: CommandOutput): string {
  const streams = [boundedStream("stdout", result.stdout), boundedStream("stderr", result.stderr)];
  return (
    streams.filter((stream): stream is string => stream !== undefined).join("\n") ||
    "no command output"
  );
}
