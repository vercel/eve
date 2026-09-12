import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
  type VercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type {
  VercelCreateOptions,
  VercelDeleteGetOptions,
  VercelDeleteModule,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxBackendSessionState } from "#public/definitions/sandbox-backend.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";

export async function deleteVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelDeleteModule>;
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await stopVercelSandbox(input.sandbox);
  await deleteVercelSandboxRecord(input);
}

export async function deleteUnusableVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelDeleteModule>;
  readonly sandbox: VercelSandbox;
}): Promise<void> {
  await deleteVercelSandboxRecord(input);
}

async function deleteVercelSandboxRecord(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelDeleteModule>;
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

export type VercelSandboxStopExistingResult = "stopped" | "not-running" | "not-found";

/**
 * Stops a persisted Vercel sandbox without resuming or initializing it.
 *
 * Durable lifecycle hooks use this path when they run in a later step than
 * the one that opened the sandbox. It must never call the backend's normal
 * create path because that path can resume the VM and run framework setup.
 */
export async function stopExistingVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly state: SandboxBackendSessionState;
}): Promise<VercelSandboxStopExistingResult> {
  const sandboxName = input.state.metadata.sandboxName;
  if (typeof sandboxName !== "string" || sandboxName.length === 0) {
    return "not-found";
  }

  const sandbox = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule: await input.loadSandboxModule(),
    sandboxName,
  });
  if (sandbox === null) return "not-found";
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return "not-running";
  }

  await sandbox.stop();
  return "stopped";
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
