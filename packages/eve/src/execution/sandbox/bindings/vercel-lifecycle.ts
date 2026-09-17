import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
  type VercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type {
  VercelCreateOptions,
  VercelGetOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export async function deleteVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandbox: VercelSandbox;
  readonly sandboxModule: VercelModule;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await stopVercelSandbox(input.sandbox);
  await deleteVercelSandboxRecord(input);
}

export async function deleteUnusableVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandbox: VercelSandbox;
  readonly sandboxModule: VercelModule;
}): Promise<void> {
  await deleteVercelSandboxRecord(input);
}

async function deleteVercelSandboxRecord(input: {
  readonly createOptions: VercelCreateOptions;
  readonly sandbox: VercelSandbox;
  readonly sandboxModule: VercelModule;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const credentials = await resolveVercelSandboxCredentials(input.createOptions);
  const sandbox = await input.sandboxModule.Sandbox.get({
    ...credentials,
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandbox.name,
    resume: false,
    signal: input.signal,
  } as VercelGetOptions);
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

async function resolveVercelSandboxCredentials(
  createOptions: VercelCreateOptions,
): Promise<VercelSandboxCredentials | Record<string, never>> {
  try {
    return await getVercelSandboxCredentials(createOptions);
  } catch {
    return {};
  }
}
