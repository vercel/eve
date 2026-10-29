/** A provider's recorded session state does not match the shape this eve version writes. */
export function invalidSandboxSessionStateError(label: string): Error {
  return new Error(
    `Invalid ${label} session state. ` +
      "This session's recorded sandbox state does not match the format this eve version expects, usually because the session started under a different eve version. " +
      "Start a new session to get a fresh sandbox.",
  );
}

/** A provider's prepared artifact from `eve build` does not match the shape this eve version writes. */
export function invalidPreparedSandboxArtifactError(label: string): Error {
  return new Error(
    `Invalid prepared ${label} artifact. ` +
      "The artifact recorded by `eve build` does not match the format this eve version expects, usually because the build used a different eve version. " +
      "Run `eve build` with the eve version this runtime uses, then redeploy.",
  );
}
