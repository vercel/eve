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

export async function deleteVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await stopVercelSandbox(input.sandbox);
  await deleteVercelSandboxRecord(input);
}

/** Deletes the sandbox with this name, if there is one. */
export async function deleteNamedVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandboxName: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const sandbox = await getNamedVercelSandbox({
    createOptions:
      input.signal === undefined
        ? input.createOptions
        : { ...input.createOptions, signal: input.signal },
    sandboxModule: await input.loadDeleteSandboxModule(),
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

export async function deleteUnusableVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
}): Promise<void> {
  await deleteVercelSandboxRecord(input);
}

async function deleteVercelSandboxRecord(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const credentials = await resolveVercelSandboxCredentials(input.createOptions);
  const sandboxModule = await input.loadDeleteSandboxModule();
  const sandbox = await sandboxModule.Sandbox.get({
    ...credentials,
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandbox.name,
    resume: false,
    signal: input.signal,
  });
  await sandbox.delete({
    deleteOrphanSnapshots: true,
    signal: input.signal,
  });
}

export async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  await sandbox.stop();
}
