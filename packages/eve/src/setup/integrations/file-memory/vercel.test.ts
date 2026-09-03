import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";

import {
  applyFileMemoryBlob,
  FILE_MEMORY_BLOB_ENVIRONMENTS,
  FILE_MEMORY_BLOB_PREFIX,
  fileMemoryStoreName,
  type BlobStore,
  type BlobStoreConnection,
  type BlobStoreReference,
  type FileMemoryBlobPlan,
  type FileMemoryVercelClient,
  prepareFileMemoryBlob,
  resolveFileMemoryRegion,
} from "./vercel.js";

const project = { orgId: "team_acme", projectId: "prj_123456789" };
const projectConfiguration = { id: project.projectId, name: "Memory Agent" };
const storeName = fileMemoryStoreName(projectConfiguration.name, project.projectId);
const privateStore: BlobStore = {
  access: "private",
  id: "store_memory",
  name: storeName,
  region: "iad1",
  type: "blob",
};
const exactConnection: BlobStoreConnection = {
  envVarEnvironments: [...FILE_MEMORY_BLOB_ENVIRONMENTS],
  envVarPrefix: FILE_MEMORY_BLOB_PREFIX,
  projectId: project.projectId,
};

function reference(store: BlobStore, connected = true): BlobStoreReference {
  return {
    id: store.id,
    name: store.name,
    projects: connected ? [{ id: project.projectId, name: projectConfiguration.name }] : [],
    region: store.region,
  };
}

function client(overrides: Partial<FileMemoryVercelClient> = {}): FileMemoryVercelClient {
  return {
    createStore: vi.fn(async () => privateStore),
    connectStore: vi.fn(async () => {}),
    getConnections: vi.fn(async () => []),
    getProject: vi.fn(async () => projectConfiguration),
    getStore: vi.fn(async () => privateStore),
    listStores: vi.fn(async () => []),
    pullEnvironment: vi.fn(async () => {}),
    ...overrides,
  };
}

function log(): ChannelSetupLog {
  return {
    commandOutput: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  };
}

function plan(action: FileMemoryBlobPlan["action"]): FileMemoryBlobPlan {
  return {
    action,
    project,
    projectName: projectConfiguration.name,
    region: privateStore.region,
    storeId: action === "create" ? undefined : privateStore.id,
    storeName,
  };
}

async function prepareWith(storageClient: FileMemoryVercelClient): Promise<FileMemoryBlobPlan> {
  return await prepareFileMemoryBlob({
    appRoot: "/project",
    client: storageClient,
    localRegions: async () => undefined,
    project,
  });
}

describe("file-memory Blob region", () => {
  it("uses local, project, default, then Vercel region precedence", () => {
    const configured = {
      resourceConfig: { functionDefaultRegions: ["sfo1", "iad1"] },
      defaultResourceConfig: { functionDefaultRegions: ["fra1"] },
    };
    expect(resolveFileMemoryRegion({ localRegions: ["hnd1", "sfo1"], project: configured })).toBe(
      "hnd1",
    );
    expect(resolveFileMemoryRegion({ project: configured })).toBe("sfo1");
    expect(
      resolveFileMemoryRegion({
        project: { defaultResourceConfig: { functionDefaultRegions: ["fra1", "iad1"] } },
      }),
    ).toBe("fra1");
    expect(resolveFileMemoryRegion({ project: {} })).toBe("iad1");
  });
});

describe("file-memory Blob reconciliation", () => {
  it("plans a fresh private store when no eve resource exists", async () => {
    await expect(prepareWith(client())).resolves.toMatchObject({
      action: "create",
      projectName: "Memory Agent",
      region: "iad1",
      storeName,
    });
  });

  it("reuses one complete private eve connection", async () => {
    const storageClient = client({
      getConnections: vi.fn(async () => [exactConnection]),
      listStores: vi.fn(async () => [reference(privateStore)]),
    });
    await expect(prepareWith(storageClient)).resolves.toMatchObject({
      action: "reuse",
      storeId: privateStore.id,
    });
  });

  it("repairs the deterministic private store left by a partial run", async () => {
    const storageClient = client({
      listStores: vi.fn(async () => [reference(privateStore, false)]),
    });
    await expect(prepareWith(storageClient)).resolves.toMatchObject({
      action: "repair",
      storeId: privateStore.id,
    });
  });

  it("leaves a public application Blob store alone", async () => {
    const applicationStore: BlobStore = {
      ...privateStore,
      access: "public",
      id: "store_application",
      name: "uploads",
    };
    const storageClient = client({
      getConnections: vi.fn(async () => [
        {
          envVarEnvironments: ["production"],
          envVarPrefix: "BLOB_",
          projectId: project.projectId,
        },
      ]),
      getStore: vi.fn(async () => applicationStore),
      listStores: vi.fn(async () => [reference(applicationStore)]),
    });
    await expect(prepareWith(storageClient)).resolves.toMatchObject({ action: "create" });
  });

  it("rejects an incompatible eve-prefixed binding", async () => {
    const storageClient = client({
      getConnections: vi.fn(async () => [
        { ...exactConnection, envVarPrefix: "EVE_MEMORY_LEGACY_" },
      ]),
      listStores: vi.fn(async () => [reference(privateStore)]),
    });
    await expect(prepareWith(storageClient)).rejects.toThrow("incompatible eve file-memory prefix");
  });

  it("rejects a public store connected as eve memory", async () => {
    const storageClient = client({
      getConnections: vi.fn(async () => [exactConnection]),
      getStore: vi.fn(async () => ({ ...privateStore, access: "public" as const })),
      listStores: vi.fn(async () => [reference(privateStore)]),
    });
    await expect(prepareWith(storageClient)).rejects.toThrow("is public");
  });

  it("preserves a connected store after project region drift", async () => {
    const existing = { ...privateStore, region: "sfo1" };
    const storageClient = client({
      getConnections: vi.fn(async () => [exactConnection]),
      getProject: vi.fn(async () => ({
        ...projectConfiguration,
        resourceConfig: { functionDefaultRegions: ["iad1"] },
      })),
      getStore: vi.fn(async () => existing),
      listStores: vi.fn(async () => [reference(existing)]),
    });
    await expect(prepareWith(storageClient)).resolves.toMatchObject({
      action: "reuse",
      region: "sfo1",
      regionWarning: expect.stringContaining("preserved the store"),
    });
  });

  it("rejects duplicate eve connections", async () => {
    const other = { ...privateStore, id: "store_other", name: "eve-memory-other-123" };
    const storageClient = client({
      getConnections: vi.fn(async () => [exactConnection]),
      getStore: vi.fn(async (id) => (id === privateStore.id ? privateStore : other)),
      listStores: vi.fn(async () => [reference(privateStore), reference(other)]),
    });
    await expect(prepareWith(storageClient)).rejects.toThrow("Multiple Vercel Blob connections");
  });

  it("rejects duplicate eve connections on one store", async () => {
    const storageClient = client({
      getConnections: vi.fn(async () => [exactConnection, { ...exactConnection, id: "con_2" }]),
      listStores: vi.fn(async () => [reference(privateStore)]),
    });
    await expect(prepareWith(storageClient)).rejects.toThrow("Multiple Vercel Blob connections");
  });
});

describe("file-memory Blob apply", () => {
  it("creates, connects, pulls, and verifies a fresh store", async () => {
    const storageClient = client({ getConnections: vi.fn(async () => [exactConnection]) });
    await expect(
      applyFileMemoryBlob({
        appRoot: "/project",
        client: storageClient,
        log: log(),
        plan: plan("create"),
      }),
    ).resolves.toMatchObject({ action: "create", store: privateStore });
    expect(storageClient.createStore).toHaveBeenCalledWith({ name: storeName, region: "iad1" });
    expect(storageClient.connectStore).toHaveBeenCalledWith({
      environments: FILE_MEMORY_BLOB_ENVIRONMENTS,
      prefix: FILE_MEMORY_BLOB_PREFIX,
      projectId: project.projectId,
      storeName,
    });
    expect(storageClient.pullEnvironment).toHaveBeenCalledOnce();
  });

  it("re-pulls and verifies a reused connection without reconnecting it", async () => {
    const storageClient = client({ getConnections: vi.fn(async () => [exactConnection]) });
    await applyFileMemoryBlob({
      appRoot: "/project",
      client: storageClient,
      log: log(),
      plan: plan("reuse"),
    });
    expect(storageClient.createStore).not.toHaveBeenCalled();
    expect(storageClient.connectStore).not.toHaveBeenCalled();
    expect(storageClient.pullEnvironment).toHaveBeenCalledOnce();
  });

  it("reports environment-pull failure before success", async () => {
    const storageClient = client({
      pullEnvironment: vi.fn(async () => {
        throw new Error("env pull failed");
      }),
    });
    await expect(
      applyFileMemoryBlob({
        appRoot: "/project",
        client: storageClient,
        log: log(),
        plan: plan("repair"),
      }),
    ).rejects.toThrow("env pull failed");
    expect(storageClient.getStore).not.toHaveBeenCalled();
  });
});
