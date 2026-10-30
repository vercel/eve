import {
  getVercelSandboxFetch,
  resolveVercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { isVercelSandboxMissingError } from "#execution/sandbox/bindings/vercel-errors.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

/** Deletes the sandbox with this name, if there is one. */
export async function deleteNamedVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly sandboxName: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const sandbox = await getNamedVercelSandbox({
    createOptions:
      input.signal === undefined
        ? input.createOptions
        : { ...input.createOptions, signal: input.signal },
    sandboxModule: input.sandboxModule,
    sandboxName: input.sandboxName,
  });
  if (sandbox === null) return;
  try {
    await stopVercelSandbox(sandbox);
    await sandbox.delete({ deleteOrphanSnapshots: true, signal: input.signal });
  } catch (error) {
    // Another cleanup attempt deleted it first.
    if (!isVercelSandboxMissingError(error)) throw error;
  }
}

/** Deletes a sandbox that can no longer resume, without stopping it first. */
export async function deleteUnusableVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
  readonly sandboxName: string;
}): Promise<void> {
  const sandbox = await input.sandboxModule.Sandbox.get({
    ...(await resolveVercelSandboxCredentials(input.createOptions)),
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandboxName,
    resume: false,
  });
  await sandbox.delete({ deleteOrphanSnapshots: true });
}

export async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  await sandbox.stop();
}
