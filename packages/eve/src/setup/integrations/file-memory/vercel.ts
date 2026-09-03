import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  captureVercel,
  type RunVercelOptions,
  type VercelCaptureResult,
} from "#setup/primitives/run-vercel.js";

export const FILE_MEMORY_BLOB_PREFIX = "EVE_MEMORY_";
export const FILE_MEMORY_BLOB_ENVIRONMENTS = ["production", "preview", "development"] as const;
const DEFAULT_BLOB_REGION = "iad1";

const ProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    resourceConfig: z
      .object({ functionDefaultRegions: z.array(z.string().min(1)).optional() })
      .optional(),
    defaultResourceConfig: z
      .object({ functionDefaultRegions: z.array(z.string().min(1)).optional() })
      .optional(),
  })
  .passthrough();

const StoreReferenceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    projects: z
      .array(z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough())
      .default([]),
    region: z.string().min(1).optional(),
  })
  .passthrough();

const StoreSchema = z
  .object({
    access: z.enum(["private", "public"]),
    id: z.string().min(1),
    name: z.string().min(1),
    region: z.string().min(1),
    type: z.string().optional(),
  })
  .passthrough();

const StoreConnectionSchema = z
  .object({
    envVarEnvironments: z.array(z.string()).default([]),
    envVarPrefix: z.string().nullish(),
    id: z.string().optional(),
    projectId: z.string().min(1),
  })
  .passthrough();

export type VercelProjectConfiguration = z.infer<typeof ProjectSchema>;
export type BlobStoreReference = z.infer<typeof StoreReferenceSchema>;
export type BlobStore = z.infer<typeof StoreSchema>;
export type BlobStoreConnection = z.infer<typeof StoreConnectionSchema>;

export interface FileMemoryVercelClient {
  createStore(input: { name: string; region: string }): Promise<BlobStore>;
  connectStore(input: {
    environments: readonly string[];
    prefix: string;
    projectId: string;
    storeName: string;
  }): Promise<void>;
  getConnections(storeId: string): Promise<readonly BlobStoreConnection[]>;
  getProject(): Promise<VercelProjectConfiguration>;
  getStore(storeId: string): Promise<BlobStore>;
  listStores(): Promise<readonly BlobStoreReference[]>;
  pullEnvironment(): Promise<void>;
}

export type FileMemoryBlobAction = "create" | "repair" | "reuse";

export interface FileMemoryBlobPlan {
  readonly action: FileMemoryBlobAction;
  readonly project: VercelProjectReference;
  readonly projectName: string;
  readonly region: string;
  readonly storeId?: string;
  readonly storeName: string;
  readonly regionWarning?: string;
}

export interface FileMemoryBlobResult {
  readonly action: FileMemoryBlobAction;
  readonly store: BlobStore;
}

interface FileMemoryVercelClientInput {
  readonly appRoot: string;
  readonly project: VercelProjectReference;
  readonly signal?: AbortSignal;
  readonly onOutput?: RunVercelOptions["onOutput"];
}

function parseJson<T>(stdout: string, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(JSON.parse(stdout));
  } catch {
    throw new Error(`Vercel returned invalid ${label} data. Upgrade the Vercel CLI and try again.`);
  }
}

function commandFailure(label: string, result: Extract<VercelCaptureResult, { ok: false }>): Error {
  const detail = [result.failure.stderr, result.failure.stdout, result.failure.message].find(
    (value) => value.trim().length > 0,
  );
  return new Error(detail === undefined ? `${label} failed.` : `${label} failed: ${detail.trim()}`);
}

export function createFileMemoryVercelClient(
  input: FileMemoryVercelClientInput,
): FileMemoryVercelClient {
  const baseOptions: RunVercelOptions = {
    cwd: input.appRoot,
    nonInteractive: true,
    onOutput: input.onOutput,
    signal: input.signal,
  };
  const scope = ["--scope", input.project.orgId];

  async function captureJson<T>(
    args: string[],
    schema: z.ZodType<T>,
    label: string,
    stdin?: string,
  ): Promise<T> {
    const result = await captureVercel(args, { ...baseOptions, stdin });
    input.signal?.throwIfAborted();
    if (!result.ok) throw commandFailure(label, result);
    return parseJson(result.stdout, schema, label.toLowerCase());
  }

  async function captureMutation(args: string[], label: string): Promise<void> {
    const result = await captureVercel(args, baseOptions);
    input.signal?.throwIfAborted();
    if (!result.ok) throw commandFailure(label, result);
  }

  return {
    async createStore({ name, region }) {
      const response = await captureJson(
        ["api", "/v1/storage/stores/blob", "-X", "POST", "--input", "-", "--raw", ...scope],
        z.object({ store: StoreSchema }),
        "Vercel Blob store creation",
        JSON.stringify({ access: "private", name, region }),
      );
      return response.store;
    },
    async connectStore({ environments, prefix, projectId, storeName }) {
      const args = [
        "integration-resource",
        "connect",
        storeName,
        projectId,
        "--prefix",
        prefix,
        ...environments.flatMap((environment) => ["--environment", environment]),
        "--yes",
        ...scope,
      ];
      await captureMutation(args, "Vercel Blob project connection");
    },
    async getConnections(storeId) {
      const response = await captureJson(
        ["api", `/v1/storage/stores/${encodeURIComponent(storeId)}/connections`, "--raw", ...scope],
        z.object({ connections: z.array(StoreConnectionSchema) }),
        "Vercel Blob connections lookup",
      );
      return response.connections;
    },
    async getProject() {
      return await captureJson(
        [
          "api",
          `/v9/projects/${encodeURIComponent(input.project.projectId)}?teamId=${encodeURIComponent(input.project.orgId)}`,
          "--raw",
          ...scope,
        ],
        ProjectSchema,
        "Vercel project lookup",
      );
    },
    async getStore(storeId) {
      const response = await captureJson(
        ["api", `/v1/storage/stores/${encodeURIComponent(storeId)}`, "--raw", ...scope],
        z.object({ store: StoreSchema }),
        "Vercel Blob store lookup",
      );
      return response.store;
    },
    async listStores() {
      const response = await captureJson(
        ["blob", "list-stores", "--all", "--json", ...scope],
        z.object({ stores: z.array(StoreReferenceSchema) }),
        "Vercel Blob stores lookup",
      );
      return response.stores;
    },
    async pullEnvironment() {
      await captureMutation(
        ["env", "pull", ".env.local", "--yes", "--project", input.project.projectId, ...scope],
        "Vercel environment pull",
      );
    },
  };
}

export function resolveFileMemoryRegion(input: {
  readonly localRegions?: readonly string[];
  readonly project: Pick<VercelProjectConfiguration, "defaultResourceConfig" | "resourceConfig">;
}): string {
  return (
    input.localRegions?.[0] ??
    input.project.resourceConfig?.functionDefaultRegions?.[0] ??
    input.project.defaultResourceConfig?.functionDefaultRegions?.[0] ??
    DEFAULT_BLOB_REGION
  );
}

export function fileMemoryStoreName(projectName: string, projectId: string): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "project";
  const suffix =
    projectId
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "")
      .slice(-8) || "memory";
  const fixedLength = "eve-memory--".length + suffix.length;
  return `eve-memory-${slug.slice(0, 64 - fixedLength).replace(/-+$/gu, "")}-${suffix}`;
}

async function readLocalRegions(appRoot: string): Promise<readonly string[] | undefined> {
  try {
    const contents = await readFile(join(appRoot, "vercel.json"), "utf8");
    const parsed = z
      .object({ regions: z.array(z.string().min(1)).optional() })
      .safeParse(JSON.parse(contents));
    if (!parsed.success) {
      throw new Error("vercel.json has an invalid `regions` value.");
    }
    return parsed.data.regions;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("vercel.json contains invalid JSON.");
    throw error;
  }
}

function hasProject(reference: BlobStoreReference, projectId: string): boolean {
  return reference.projects.some((project) => project.id === projectId);
}

function exactConnection(connection: BlobStoreConnection, projectId: string): boolean {
  return connection.projectId === projectId && connection.envVarPrefix === FILE_MEMORY_BLOB_PREFIX;
}

function isEveMemoryConnection(connection: BlobStoreConnection, projectId: string): boolean {
  return (
    connection.projectId === projectId &&
    connection.envVarPrefix?.startsWith(FILE_MEMORY_BLOB_PREFIX) === true
  );
}

function assertPrivateBlobStore(store: BlobStore): void {
  if (store.type !== undefined && store.type !== "blob") {
    throw new Error(
      `Vercel resource "${store.name}" uses the eve file-memory prefix but is not a Blob store. Disconnect that binding before retrying.`,
    );
  }
  if (store.access !== "private") {
    throw new Error(
      `Vercel Blob store "${store.name}" is public. Disconnect an eve-prefixed binding or choose a private store before retrying; eve will not replace it automatically.`,
    );
  }
}

function assertCompleteConnection(connection: BlobStoreConnection, storeName: string): void {
  const missing = FILE_MEMORY_BLOB_ENVIRONMENTS.filter(
    (environment) => !connection.envVarEnvironments.includes(environment),
  );
  if (missing.length > 0) {
    throw new Error(
      `Vercel Blob store "${storeName}" has an incomplete ${FILE_MEMORY_BLOB_PREFIX} connection. Reconnect it for production, preview, and development before retrying; eve will not disconnect or replace it automatically.`,
    );
  }
}

interface InspectedStore {
  readonly connections: readonly BlobStoreConnection[];
  readonly store: BlobStore;
}

async function inspectStore(
  reference: BlobStoreReference,
  client: FileMemoryVercelClient,
): Promise<InspectedStore> {
  const [store, connections] = await Promise.all([
    client.getStore(reference.id),
    client.getConnections(reference.id),
  ]);
  return { connections, store };
}

export async function prepareFileMemoryBlob(input: {
  readonly appRoot: string;
  readonly project: VercelProjectReference;
  readonly client?: FileMemoryVercelClient;
  readonly localRegions?: () => Promise<readonly string[] | undefined>;
  readonly signal?: AbortSignal;
}): Promise<FileMemoryBlobPlan> {
  const client =
    input.client ??
    createFileMemoryVercelClient({
      appRoot: input.appRoot,
      project: input.project,
      signal: input.signal,
    });
  const [project, localRegions, stores] = await Promise.all([
    client.getProject(),
    input.localRegions?.() ?? readLocalRegions(input.appRoot),
    client.listStores(),
  ]);
  input.signal?.throwIfAborted();
  if (project.id !== input.project.projectId) {
    throw new Error(
      `Vercel returned project "${project.id}" while file-memory setup expected "${input.project.projectId}". Relink the project and retry.`,
    );
  }
  const region = resolveFileMemoryRegion({ localRegions, project });
  const storeName = fileMemoryStoreName(project.name, project.id);
  const candidates = stores.filter(
    (store) => store.name === storeName || hasProject(store, input.project.projectId),
  );
  const inspected = await Promise.all(
    candidates.map(async (reference) => await inspectStore(reference, client)),
  );

  const exact = inspected.flatMap((candidate) =>
    candidate.connections
      .filter((connection) => exactConnection(connection, input.project.projectId))
      .map((connection) => ({ candidate, connection })),
  );
  if (exact.length > 1) {
    throw new Error(
      `Multiple Vercel Blob connections target project "${project.name}" with prefix ${FILE_MEMORY_BLOB_PREFIX}. Disconnect the extra binding before retrying.`,
    );
  }
  if (exact.length === 1) {
    const match = exact[0];
    if (match === undefined) throw new Error("Expected an eve file-memory Blob store.");
    const { candidate, connection } = match;
    assertPrivateBlobStore(candidate.store);
    assertCompleteConnection(connection, candidate.store.name);
    const regionWarning =
      candidate.store.region === region
        ? undefined
        : `The existing file-memory store remains in ${candidate.store.region}; the project now prefers ${region}. eve preserved the store to avoid memory loss.`;
    return {
      action: "reuse",
      project: input.project,
      projectName: project.name,
      region: candidate.store.region,
      regionWarning,
      storeId: candidate.store.id,
      storeName: candidate.store.name,
    };
  }

  const incompatible = inspected.find(({ connections }) =>
    connections.some((connection) => isEveMemoryConnection(connection, input.project.projectId)),
  );
  if (incompatible !== undefined) {
    throw new Error(
      `Vercel resource "${incompatible.store.name}" has an incompatible eve file-memory prefix. Disconnect it before retrying; eve will not change an ambiguous binding automatically.`,
    );
  }

  const named = inspected.filter(({ store }) => store.name === storeName);
  if (named.length > 1) {
    throw new Error(
      `Multiple Vercel Blob stores match the expected file-memory name "${storeName}". Rename or remove the duplicate before retrying.`,
    );
  }
  if (named.length === 1) {
    const candidate = named[0];
    if (candidate === undefined) throw new Error("Expected a file-memory Blob store candidate.");
    assertPrivateBlobStore(candidate.store);
    if (candidate.store.region !== region) {
      throw new Error(
        `Unconnected Vercel Blob store "${storeName}" is in ${candidate.store.region}, but project "${project.name}" uses ${region}. Rename that store or connect it manually; eve will not replace it automatically.`,
      );
    }
    if (candidate.connections.length > 0) {
      throw new Error(
        `Vercel Blob store "${storeName}" already has a project connection, so eve cannot safely adopt it. Disconnect it or choose a different store before retrying.`,
      );
    }
    return {
      action: "repair",
      project: input.project,
      projectName: project.name,
      region,
      storeId: candidate.store.id,
      storeName,
    };
  }

  return {
    action: "create",
    project: input.project,
    projectName: project.name,
    region,
    storeName,
  };
}

async function verifyFileMemoryBlob(
  plan: FileMemoryBlobPlan,
  storeId: string,
  client: FileMemoryVercelClient,
): Promise<BlobStore> {
  const [store, connections] = await Promise.all([
    client.getStore(storeId),
    client.getConnections(storeId),
  ]);
  assertPrivateBlobStore(store);
  if (store.name !== plan.storeName) {
    throw new Error(`Vercel connected an unexpected Blob store named "${store.name}".`);
  }
  if (store.region !== plan.region) {
    throw new Error(
      `Vercel Blob store "${store.name}" is in ${store.region}, but setup expected ${plan.region}.`,
    );
  }
  const matching = connections.filter((connection) =>
    exactConnection(connection, plan.project.projectId),
  );
  if (matching.length !== 1) {
    throw new Error(
      `Vercel Blob store "${store.name}" does not have exactly one ${FILE_MEMORY_BLOB_PREFIX} connection to project "${plan.projectName}".`,
    );
  }
  const connection = matching[0];
  if (connection === undefined) throw new Error("Expected a verified eve file-memory connection.");
  assertCompleteConnection(connection, store.name);
  return store;
}

export async function applyFileMemoryBlob(input: {
  readonly client?: FileMemoryVercelClient;
  readonly log: ChannelSetupLog;
  readonly plan: FileMemoryBlobPlan;
  readonly appRoot: string;
  readonly signal?: AbortSignal;
}): Promise<FileMemoryBlobResult> {
  const onOutput = createPromptCommandOutput(input.log);
  const client =
    input.client ??
    createFileMemoryVercelClient({
      appRoot: input.appRoot,
      onOutput,
      project: input.plan.project,
      signal: input.signal,
    });
  let storeId = input.plan.storeId;
  if (input.plan.action === "create") {
    const store = await withPhase(
      input.log,
      "Creating private Vercel Blob store...",
      async () =>
        await client.createStore({ name: input.plan.storeName, region: input.plan.region }),
    );
    assertPrivateBlobStore(store);
    if (store.name !== input.plan.storeName || store.region !== input.plan.region) {
      throw new Error(
        `Vercel created Blob store "${store.name}" in ${store.region}, but setup expected "${input.plan.storeName}" in ${input.plan.region}.`,
      );
    }
    storeId = store.id;
  }
  if (storeId === undefined) throw new Error("File-memory Blob setup did not resolve a store ID.");

  if (input.plan.action !== "reuse") {
    await withPhase(
      input.log,
      "Connecting file memory to the Vercel project...",
      async () =>
        await client.connectStore({
          environments: FILE_MEMORY_BLOB_ENVIRONMENTS,
          prefix: FILE_MEMORY_BLOB_PREFIX,
          projectId: input.plan.project.projectId,
          storeName: input.plan.storeName,
        }),
    );
  }
  await withPhase(
    input.log,
    "Pulling Vercel environment variables...",
    async () => await client.pullEnvironment(),
  );
  const store = await withPhase(
    input.log,
    "Verifying file-memory storage...",
    async () => await verifyFileMemoryBlob(input.plan, storeId, client),
  );
  return { action: input.plan.action, store };
}
