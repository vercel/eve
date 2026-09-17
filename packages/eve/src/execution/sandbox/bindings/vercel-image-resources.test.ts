import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareVercelImageResource,
  resolveVercelImageMounts,
} from "#execution/sandbox/bindings/vercel-image-resources.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";

function setCredentials() {
  vi.stubEnv(
    "VERCEL_OIDC_TOKEN",
    createFakeVercelOidcToken({ owner_id: "team-id", project_id: "project-id" }),
  );
  vi.stubEnv("VERCEL_ORG_ID", "team-id");
  vi.stubEnv("VERCEL_PROJECT_ID", "project-id");
}

function resource() {
  return {
    files: [{ content: "seed", relativePath: "seed.txt" }],
    key: "workspace-key",
    mountPath: "/eve/resources/workspace",
    targetPath: "/workspace",
  };
}

function createDrive(name = "drive") {
  return {
    name,
    region: "iad1",
    snapshot: vi.fn(() => ({ drive: name, mode: "snapshot" as const })),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("Vercel image resources", () => {
  it("creates and populates a content-addressed Drive", async () => {
    setCredentials();
    const drive = createDrive();
    const writeFiles = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const module = {
      Drive: {
        getOrCreate: vi.fn(async (input: { name: string }) => ({ ...drive, name: input.name })),
        list: vi.fn(async () => ({ toArray: async () => [] })),
      },
      Sandbox: {
        create: vi.fn(async () => ({
          delete: remove,
          fs: {
            readFile: vi.fn(async () => {
              throw Object.assign(new Error("missing"), { code: "ENOENT" });
            }),
          },
          writeFiles,
        })),
      },
    };
    const result = await prepareVercelImageResource({
      createOptions: {},
      module: module as never,
      resource: resource(),
    });

    expect(module.Drive.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^eve-sbx-res-[a-f0-9]{32}$/u) }),
    );
    expect(writeFiles).toHaveBeenCalledWith(
      [
        { content: "seed", path: "/eve/upload/seed.txt" },
        {
          content: JSON.stringify({ key: "workspace-key" }),
          path: "/eve/upload/.eve-resource.json",
        },
      ],
      { signal: undefined },
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      mountPath: "/eve/resources/workspace",
      region: "iad1",
      resourceKey: "workspace-key",
    });
  });

  it("rejects conflicting content under an existing Drive identity", async () => {
    setCredentials();
    const module = {
      Drive: {
        getOrCreate: vi.fn(),
        list: vi.fn(async (input: { namePrefix: string }) => ({
          toArray: async () => [createDrive(input.namePrefix)],
        })),
      },
      Sandbox: {
        create: vi.fn(async () => ({
          delete: vi.fn(async () => {}),
          fs: {
            readFile: vi.fn(async () => JSON.stringify({ key: "different-resource" })),
          },
          writeFiles: vi.fn(),
        })),
      },
    };
    await expect(
      prepareVercelImageResource({
        createOptions: {},
        module: module as never,
        resource: resource(),
      }),
    ).rejects.toThrow("conflicts with existing content");
  });

  it("strictly resolves prepared Drives without creating replacements", async () => {
    setCredentials();
    const module = {
      Drive: {
        getOrCreate: vi.fn(),
        list: vi.fn(async () => ({ toArray: async () => [] })),
      },
      Sandbox: { create: vi.fn() },
    };
    await expect(
      resolveVercelImageMounts({
        module: module as never,
        createOptions: {},
        mounts: [
          {
            driveName: "missing-drive",
            mountPath: "/eve/resources/workspace",
            region: "iad1",
            resourceKey: "workspace-key",
          },
        ],
      }),
    ).rejects.toThrow('Prepared sandbox resource "workspace-key" is unavailable');
    expect(module.Drive.getOrCreate).not.toHaveBeenCalled();
  });
});
