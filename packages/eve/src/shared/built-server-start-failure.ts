const SRVX_START_FAILURE_MARKER = "[srvx] Failed to start server:";

export class BuiltServerPortInUseError extends Error {
  override readonly name = "BuiltServerPortInUseError";
}

export function readBuiltServerStartFailure(
  output: string,
  listen: { readonly host: string; readonly port: number | string; readonly retryHint: string },
): Error | undefined {
  const failureIndex = output.indexOf(SRVX_START_FAILURE_MARKER);
  const failureLineEnd = failureIndex === -1 ? -1 : output.indexOf("\n", failureIndex);

  if (failureLineEnd === -1) {
    return undefined;
  }

  const failure = output.slice(failureIndex);

  if (output.slice(failureIndex, failureLineEnd).includes("EADDRINUSE")) {
    return new BuiltServerPortInUseError(
      `Port ${String(listen.port)} on ${listen.host} is already in use. Another process is listening there; stop it or ${listen.retryHint}.`,
    );
  }

  return new Error(
    [`Built eve server failed to start on ${listen.host}:${String(listen.port)}.`, failure].join(
      "\n",
    ),
  );
}
