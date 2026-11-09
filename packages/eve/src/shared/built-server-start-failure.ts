const SRVX_START_FAILURE_MARKER = "[srvx] Failed to start server:";

/**
 * Detects a built eve server that reported a failed start in `output`.
 *
 * srvx only logs a failed bind and sets `process.exitCode`, so the process can
 * stay alive without serving anything. Callers must treat this output as fatal
 * and stop the process themselves.
 */
export function readBuiltServerStartFailure(
  output: string,
  listen: { readonly host: string; readonly port: number | string; readonly retryHint: string },
): Error | undefined {
  const failureIndex = output.indexOf(SRVX_START_FAILURE_MARKER);
  // The error code is on the marker line; wait for the line to end so a
  // partial read is not misclassified.
  const failureLineEnd = failureIndex === -1 ? -1 : output.indexOf("\n", failureIndex);

  if (failureLineEnd === -1) {
    return undefined;
  }

  const failure = output.slice(failureIndex);

  if (output.slice(failureIndex, failureLineEnd).includes("EADDRINUSE")) {
    return new Error(
      `Port ${String(listen.port)} on ${listen.host} is already in use. Another process is listening there; stop it or ${listen.retryHint}.`,
    );
  }

  return new Error(
    [`Built eve server failed to start on ${listen.host}:${String(listen.port)}.`, failure].join(
      "\n",
    ),
  );
}
