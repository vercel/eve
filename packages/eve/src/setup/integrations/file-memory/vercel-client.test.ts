import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureVercel } = vi.hoisted(() => ({ captureVercel: vi.fn() }));

vi.mock("#setup/primitives/run-vercel.js", () => ({ captureVercel }));

import {
  createFileMemoryVercelClient,
  FILE_MEMORY_BLOB_ENVIRONMENTS,
  FILE_MEMORY_BLOB_PREFIX,
} from "./vercel.js";

const project = { orgId: "team_acme", projectId: "prj_agent" };
const store = {
  access: "private",
  id: "store_memory",
  name: "eve-memory-agent-prjagent",
  region: "iad1",
  type: "blob",
};

beforeEach(() => {
  captureVercel.mockReset();
});

describe("file-memory Vercel CLI client", () => {
  it("uses authenticated API reads and the resource connection command", async () => {
    captureVercel
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({ id: project.projectId, name: "agent" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          stores: [
            {
              id: store.id,
              name: store.name,
              projects: [{ id: project.projectId, name: "agent" }],
              region: store.region,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ store }) })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          connections: [
            {
              envVarEnvironments: FILE_MEMORY_BLOB_ENVIRONMENTS,
              envVarPrefix: FILE_MEMORY_BLOB_PREFIX,
              projectId: project.projectId,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ store }) })
      .mockResolvedValueOnce({ ok: true, stdout: "{}" })
      .mockResolvedValueOnce({ ok: true, stdout: "" });

    const client = createFileMemoryVercelClient({ appRoot: "/project", project });
    await expect(client.getProject()).resolves.toMatchObject({ id: project.projectId });
    await expect(client.listStores()).resolves.toHaveLength(1);
    await expect(client.getStore(store.id)).resolves.toEqual(store);
    await expect(client.getConnections(store.id)).resolves.toHaveLength(1);
    await expect(client.createStore({ name: store.name, region: store.region })).resolves.toEqual(
      store,
    );
    await client.connectStore({
      environments: FILE_MEMORY_BLOB_ENVIRONMENTS,
      prefix: FILE_MEMORY_BLOB_PREFIX,
      projectId: project.projectId,
      storeName: store.name,
    });
    await client.pullEnvironment();

    expect(captureVercel).toHaveBeenNthCalledWith(
      1,
      ["api", "/v9/projects/prj_agent?teamId=team_acme", "--raw", "--scope", "team_acme"],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(captureVercel).toHaveBeenNthCalledWith(
      5,
      [
        "api",
        "/v1/storage/stores/blob",
        "-X",
        "POST",
        "--input",
        "-",
        "--raw",
        "--scope",
        "team_acme",
      ],
      expect.objectContaining({
        stdin: JSON.stringify({ access: "private", name: store.name, region: store.region }),
      }),
    );
    expect(captureVercel).toHaveBeenNthCalledWith(
      6,
      [
        "integration-resource",
        "connect",
        store.name,
        project.projectId,
        "--prefix",
        FILE_MEMORY_BLOB_PREFIX,
        "--environment",
        "production",
        "--environment",
        "preview",
        "--environment",
        "development",
        "--yes",
        "--json",
        "--scope",
        "team_acme",
      ],
      expect.objectContaining({ nonInteractive: true }),
    );
    expect(captureVercel).toHaveBeenNthCalledWith(
      7,
      [
        "env",
        "pull",
        ".env.local",
        "--yes",
        "--project",
        project.projectId,
        "--scope",
        "team_acme",
      ],
      expect.objectContaining({ nonInteractive: true }),
    );
  });

  it("rejects malformed API output with an upgrade recovery", async () => {
    captureVercel.mockResolvedValue({ ok: true, stdout: "not-json" });
    const client = createFileMemoryVercelClient({ appRoot: "/project", project });
    await expect(client.getProject()).rejects.toThrow("Upgrade the Vercel CLI");
  });
});
