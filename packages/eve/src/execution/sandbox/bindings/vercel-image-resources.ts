import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

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
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxProviderResourceTree } from "#shared/sandbox-provider.js";

const DRIVE_UPLOAD_PATH = "/eve/upload";
const DRIVE_MANIFEST_PATH = `${DRIVE_UPLOAD_PATH}/.eve-resource.json`;
const RESOURCE_MANIFEST_FILE = ".eve-resource.json";

interface ResourceManifest {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly key: string;
  readonly version: 1;
}

export type VercelImageMountArtifact = {
  readonly driveName: string;
  readonly manifestDigest: string;
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
  const manifest = createResourceManifest(input.resource);
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
    manifestSource: manifest.source,
    module: input.module,
    resource: input.resource,
    signal: input.signal,
  });
  return {
    driveName,
    manifestDigest: manifest.digest,
    mountPath: input.resource.mountPath,
    region,
    resourceKey: input.resource.key,
  };
}

export type VercelImageForkArtifact = {
  readonly driveName: string;
  readonly manifestDigest: string;
  readonly mountPath: string;
  readonly resourceKey: string;
  readonly sourceDriveName: string;
};

export async function forkVercelImageMounts(input: {
  readonly createOptions: VercelCreateOptions;
  readonly module: VercelModule;
  readonly mounts: readonly VercelImageMountArtifact[];
  readonly sandboxName: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly forks: readonly VercelImageForkArtifact[];
  readonly mounts: Record<string, VercelDrive>;
}> {
  const credentials = await getVercelSandboxCredentials(input.createOptions);
  const fetch = getVercelSandboxFetch(input.createOptions);
  const forks = describeVercelImageForks(input.mounts, input.sandboxName);
  const mounts: Record<string, VercelDrive> = {};
  for (const [index, artifact] of input.mounts.entries()) {
    const forkArtifact = forks[index];
    if (forkArtifact === undefined) throw new Error("Missing Vercel image Drive fork identity.");
    let source: VercelDrive;
    try {
      source = await input.module.Drive.get({
        ...credentials,
        fetch,
        name: artifact.driveName,
        signal: input.signal,
      });
    } catch (error) {
      if (isVercelResourceMissingError(error)) {
        throw new Error(
          `Prepared sandbox resource "${artifact.resourceKey}" is unavailable. Run \`eve build\` and redeploy.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (source.region !== artifact.region) {
      throw new Error(`Prepared sandbox resource "${artifact.resourceKey}" changed regions.`);
    }
    let fork: VercelDrive;
    try {
      fork = await source.fork({ name: forkArtifact.driveName, signal: input.signal });
    } catch (forkError) {
      try {
        fork = await input.module.Drive.get({
          ...credentials,
          fetch,
          name: forkArtifact.driveName,
          signal: input.signal,
        });
      } catch {
        throw forkError;
      }
    }
    if (fork.parentDriveId !== source.driveId) {
      throw new Error(
        `Sandbox resource fork "${forkArtifact.driveName}" has an unexpected source Drive.`,
      );
    }
    mounts[artifact.mountPath] = fork;
  }
  return { forks, mounts };
}

export function describeVercelImageForks(
  mounts: readonly VercelImageMountArtifact[],
  sandboxName: string,
): readonly VercelImageForkArtifact[] {
  return mounts.map((mount) => ({
    driveName: resourceForkName(sandboxName, mount.resourceKey),
    manifestDigest: mount.manifestDigest,
    mountPath: mount.mountPath,
    resourceKey: mount.resourceKey,
    sourceDriveName: mount.driveName,
  }));
}

export async function verifyVercelImageForks(input: {
  readonly forks: readonly VercelImageForkArtifact[];
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<void> {
  for (const fork of input.forks) {
    const manifestPath = `${fork.mountPath}/${RESOURCE_MANIFEST_FILE}`;
    const source = await input.sandbox.fs.readFile(manifestPath, {
      encoding: "utf8",
      signal: input.signal,
    });
    if (sha256(source) !== fork.manifestDigest) {
      throw new Error(`Sandbox resource fork "${fork.driveName}" has unexpected content.`);
    }
    const manifest = parseResourceManifest(source);
    if (manifest.key !== fork.resourceKey) {
      throw new Error(`Sandbox resource fork "${fork.driveName}" has an unexpected identity.`);
    }
    const actualFiles = await listResourceFiles(input.sandbox, fork.mountPath, input.signal);
    const expectedFiles = [
      ...manifest.files.map((file) => file.path),
      RESOURCE_MANIFEST_FILE,
    ].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Sandbox resource fork "${fork.driveName}" has unexpected files.`);
    }
    for (const file of manifest.files) {
      const content = await input.sandbox.fs.readFile(`${fork.mountPath}/${file.path}`, {
        signal: input.signal,
      });
      if (sha256(content) !== file.sha256) {
        throw new Error(`Sandbox resource fork "${fork.driveName}" has unexpected file bytes.`);
      }
    }
    await input.sandbox.fs.rm(manifestPath, { force: true, signal: input.signal });
  }
}

async function listResourceFiles(
  sandbox: VercelSandbox,
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await sandbox.fs.readdir(directory, { signal, withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(`${directory}/${entry.name}`, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Sandbox resource contains unsupported entry "${relativePath}".`);
      }
    }
  }
  await visit(root, "");
  return files.sort();
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
  readonly manifestSource: string;
  readonly module: VercelModule;
  readonly resource: SandboxProviderResourceTree;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const credentials = await getVercelSandboxCredentials(input.createOptions);
  const createWriter = () =>
    input.module.Sandbox.create({
      ...credentials,
      fetch: getVercelSandboxFetch(input.createOptions),
      image: VERCEL_EVE_SANDBOX_IMAGE,
      mounts: { [DRIVE_UPLOAD_PATH]: input.drive },
      persistent: false,
      region: input.drive.region,
      signal: input.signal,
    });
  let writer: Awaited<ReturnType<typeof createWriter>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      writer = await createWriter();
      break;
    } catch (error) {
      if (!isDriveWriteAttachmentConflict(error) || attempt === 29) throw error;
      await sleep(1_000, undefined, { signal: input.signal });
    }
  }
  try {
    const manifest = await readResourceManifest(writer, input.signal);
    if (manifest === input.manifestSource) return true;
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
          content: input.manifestSource,
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

function isDriveWriteAttachmentConflict(error: unknown): boolean {
  return error instanceof Error && /already attached as read-write/iu.test(error.message);
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
  parseResourceManifest(source);
  return source;
}

function createResourceManifest(resource: SandboxProviderResourceTree): {
  readonly digest: string;
  readonly source: string;
} {
  const manifest: ResourceManifest = {
    files: resource.files
      .map((file) => ({ path: file.relativePath, sha256: sha256(file.content) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    key: resource.key,
    version: 1,
  };
  const source = JSON.stringify(manifest);
  return { digest: sha256(source), source };
}

function parseResourceManifest(source: string): ResourceManifest {
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
  const version = Reflect.get(value, "version");
  const files = Reflect.get(value, "files");
  if (
    typeof key !== "string" ||
    version !== 1 ||
    !Array.isArray(files) ||
    !files.every(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        typeof Reflect.get(file, "path") === "string" &&
        /^[a-f0-9]{64}$/u.test(Reflect.get(file, "sha256")),
    )
  ) {
    throw new Error("Prepared sandbox resource contains an invalid manifest.");
  }
  return { files: files as ResourceManifest["files"], key, version };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceDriveName(region: string, resourceKey: string): string {
  return `eve-sbx-res-${createHash("sha256")
    .update(region)
    .update("\0")
    .update(resourceKey)
    .digest("hex")
    .slice(0, 32)}`;
}

function resourceForkName(sandboxName: string, resourceKey: string): string {
  return `eve-sbx-fork-${createHash("sha256")
    .update(sandboxName)
    .update("\0")
    .update(resourceKey)
    .digest("hex")
    .slice(0, 32)}`;
}

function readRegion(createOptions: VercelCreateOptions): string {
  const region = createOptions.region;
  return typeof region === "string" && region.length > 0 ? region : "iad1";
}
