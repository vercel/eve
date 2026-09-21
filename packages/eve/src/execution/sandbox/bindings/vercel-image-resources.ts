import { createHash } from "node:crypto";

import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { VERCEL_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
import { isVercelResourceMissingError } from "#execution/sandbox/bindings/vercel-errors.js";
import type {
  VercelCreateOptions,
  VercelDrive,
  VercelModule,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxProviderResourceTree } from "#shared/sandbox-provider.js";

const DRIVE_UPLOAD_PATH = "/eve/upload";
const DRIVE_MANIFEST_PATH = `${DRIVE_UPLOAD_PATH}/.eve-resource.json`;

export type VercelImageMountArtifact = {
  readonly driveName: string;
  readonly mountPath: string;
  readonly region: string;
  readonly resourceKey: string;
};

export async function prepareVercelImageResource(input: {
  readonly createOptions: VercelCreateOptions;
  readonly module: VercelModule;
  readonly resource: SandboxProviderResourceTree;
  readonly signal?: AbortSignal;
}): Promise<VercelImageMountArtifact> {
  const credentials = await getVercelSandboxCredentials(input.createOptions);
  const fetch = getVercelSandboxFetch(input.createOptions);
  const region = readRegion(input.createOptions);
  const driveName = resourceDriveName(region, input.resource.key);
  const existing = await findDrive({
    credentials,
    driveName,
    fetch,
    module: input.module,
    region,
    signal: input.signal,
  });
  const drive =
    existing ??
    (await input.module.Drive.getOrCreate({
      ...credentials,
      fetch,
      name: driveName,
      region,
      signal: input.signal,
    }));
  await populateDrive({
    createOptions: input.createOptions,
    drive,
    module: input.module,
    resource: input.resource,
    signal: input.signal,
  });
  return {
    driveName,
    mountPath: input.resource.mountPath,
    region,
    resourceKey: input.resource.key,
  };
}

export async function resolveVercelImageMounts(input: {
  readonly createOptions: VercelCreateOptions;
  readonly module: VercelModule;
  readonly mounts: readonly VercelImageMountArtifact[];
  readonly signal?: AbortSignal;
}): Promise<Record<string, ReturnType<VercelDrive["snapshot"]>>> {
  const credentials = await getVercelSandboxCredentials(input.createOptions);
  const fetch = getVercelSandboxFetch(input.createOptions);
  const mounts: Record<string, ReturnType<VercelDrive["snapshot"]>> = {};
  for (const artifact of input.mounts) {
    const drive = await input.module.Drive.getOrCreate({
      ...credentials,
      fetch,
      name: artifact.driveName,
      region: artifact.region,
      signal: input.signal,
    });
    mounts[artifact.mountPath] = drive.snapshot();
  }
  return mounts;
}

async function findDrive(input: {
  readonly credentials: Awaited<ReturnType<typeof getVercelSandboxCredentials>>;
  readonly driveName: string;
  readonly fetch: typeof globalThis.fetch;
  readonly module: VercelModule;
  readonly region: string;
  readonly signal?: AbortSignal;
}): Promise<VercelDrive | null> {
  const drives = await (
    await input.module.Drive.list({
      ...input.credentials,
      fetch: input.fetch,
      namePrefix: input.driveName,
      signal: input.signal,
      sortBy: "name",
    })
  ).toArray();
  return (
    drives.find((drive) => drive.name === input.driveName && drive.region === input.region) ?? null
  );
}

async function populateDrive(input: {
  readonly createOptions: VercelCreateOptions;
  readonly drive: VercelDrive;
  readonly module: VercelModule;
  readonly resource: SandboxProviderResourceTree;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const credentials = await getVercelSandboxCredentials(input.createOptions);
  const writer = await input.module.Sandbox.create({
    ...credentials,
    fetch: getVercelSandboxFetch(input.createOptions),
    image: VERCEL_EVE_SANDBOX_IMAGE,
    mounts: { [DRIVE_UPLOAD_PATH]: input.drive },
    persistent: false,
    region: input.drive.region,
    signal: input.signal,
  });
  try {
    const manifest = await readResourceManifest(writer, input.signal);
    if (manifest === input.resource.key) return true;
    if (manifest !== null) {
      throw new Error(
        `Prepared sandbox resource "${input.resource.key}" conflicts with existing content.`,
      );
    }
    await writer.writeFiles(
      [
        ...input.resource.files.map((file) => ({
          content: file.content,
          path: `${DRIVE_UPLOAD_PATH}/${file.relativePath}`,
        })),
        {
          content: JSON.stringify({ key: input.resource.key }),
          path: DRIVE_MANIFEST_PATH,
        },
      ],
      { signal: input.signal },
    );
    return false;
  } finally {
    await writer.delete({ signal: input.signal });
  }
}

async function readResourceManifest(
  sandbox: Awaited<ReturnType<VercelModule["Sandbox"]["create"]>>,
  signal?: AbortSignal,
): Promise<string | null> {
  let source: string;
  try {
    source = await sandbox.fs.readFile(DRIVE_MANIFEST_PATH, { encoding: "utf8", signal });
  } catch (error) {
    if (
      (error instanceof Error && "code" in error && error.code === "ENOENT") ||
      isVercelResourceMissingError(error)
    ) {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error("Prepared sandbox resource contains an invalid manifest.", { cause: error });
  }
  if (value === null || typeof value !== "object") {
    throw new Error("Prepared sandbox resource contains an invalid manifest.");
  }
  const key = Reflect.get(value, "key");
  if (typeof key !== "string") {
    throw new Error("Prepared sandbox resource contains an invalid manifest.");
  }
  return key;
}

function resourceDriveName(region: string, resourceKey: string): string {
  return `eve-sbx-res-${createHash("sha256")
    .update(region)
    .update("\0")
    .update(resourceKey)
    .digest("hex")
    .slice(0, 32)}`;
}

function readRegion(createOptions: VercelCreateOptions): string {
  const region = createOptions.region;
  return typeof region === "string" && region.length > 0 ? region : "iad1";
}
