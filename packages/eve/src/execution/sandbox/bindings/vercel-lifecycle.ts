import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
  type VercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type {
  VercelCreateOptions,
  VercelDeleteGetOptions,
  VercelDeleteModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export async function deleteVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelDeleteModule>;
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await stopVercelSandbox(input.sandbox);
  const credentials = await resolveVercelSandboxCredentials(input.createOptions);
  const sandboxModule = await input.loadDeleteSandboxModule();
  const sandbox = await sandboxModule.Sandbox.get({
    ...credentials,
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandbox.name,
    resume: false,
    signal: input.signal,
  } as VercelDeleteGetOptions);
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
