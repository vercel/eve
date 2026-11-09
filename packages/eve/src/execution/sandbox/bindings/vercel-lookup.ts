import {
  getVercelSandboxFetch,
  resolveVercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import {
  isVercelSandboxMissingError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { errorMessage } from "#execution/sandbox/bindings/vercel-options.js";
import type {
  VercelCreateOptions,
  VercelGetOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export async function getNamedVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly sandboxName: string;
}): Promise<VercelSandbox | null> {
  try {
    return await input.sandboxModule.Sandbox.get(await getVercelSandboxGetOptions(input));
  } catch (error) {
    if (isVercelSandboxMissingError(error)) {
      return null;
    }

    throw new Error(
      `Failed to look up Vercel sandbox "${input.sandboxName}": ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

/** Whether a snapshot exists and finished, so a sandbox can still start from it. */
export async function isVercelSnapshotCreated(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly snapshotId: string;
}): Promise<boolean> {
  try {
    const snapshot = await input.sandboxModule.Snapshot.get({
      ...(await resolveVercelSandboxCredentials(input.createOptions)),
      fetch: getVercelSandboxFetch(input.createOptions),
      signal: input.createOptions.signal,
      snapshotId: input.snapshotId,
    });
    return snapshot.status === "created";
  } catch (error) {
    if (isVercelSandboxMissingError(error) || isVercelSnapshotUnavailableError(error)) {
      return false;
    }
    throw new Error(
      `Failed to look up Vercel snapshot "${input.snapshotId}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function getVercelSandboxGetOptions(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxName: string;
}): Promise<VercelGetOptions> {
  return {
    ...(await resolveVercelSandboxCredentials(input.createOptions)),
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandboxName,
    resume: false,
    signal: input.createOptions.signal,
  };
}
