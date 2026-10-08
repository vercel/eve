import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forkVercelImageMounts,
  prepareVercelImageResource,
  verifyVercelImageForks,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestSource(key = "workspace-key", content = "seed"): string {
  return JSON.stringify({
    files: [{ path: "seed.txt", sha256: sha256(content) }],
    key,
    version: 1,
  });
}

function resource() {
  return {
    files: [{ content: "seed", relativePath: "seed.txt" }],
    key: "workspace-key",
    mountPath: "/eve/resources/workspace",
    targetPath: "/workspace",
  };
}

function createDrive(
  name = "drive",
  options: { readonly driveId?: string; readonly parentDriveId?: string } = {},
) {
  return {
    driveId: options.driveId ?? `${name}-id`,
    name,
    parentDriveId: options.parentDriveId,
    region: "iad1",
    snapshot: vi.fn(() => ({ drive: name, mode: "snapshot" as const })),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
          content: manifestSource(),
          path: "/eve/upload/.eve-resource.json",
        },
      ],
      { signal: undefined },
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      manifestDigest: sha256(manifestSource()),
      mountPath: "/eve/resources/workspace",
      region: "iad1",
      resourceKey: "workspace-key",
    });
  });

  it("waits for another preparation writer to release the Drive", async () => {
    vi.useFakeTimers();
    setCredentials();
    const drive = createDrive();
    const writer = {
      delete: vi.fn(async () => {}),
      fs: {
        readFile: vi.fn(async () => manifestSource()),
      },
      writeFiles: vi.fn(),
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Drive is already attached as read-write to sandbox test"))
      .mockResolvedValueOnce(writer);
    const module = {
      Drive: {
        getOrCreate: vi.fn(async () => drive),
        list: vi.fn(async () => ({ toArray: async () => [] })),
      },
      Sandbox: { create },
    };
    const prepared = prepareVercelImageResource({
      createOptions: {},
      module: module as never,
      resource: resource(),
    });
    await vi.runAllTimersAsync();
    await expect(prepared).resolves.toMatchObject({ resourceKey: "workspace-key" });
    expect(create).toHaveBeenCalledTimes(2);
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
            readFile: vi.fn(async () => manifestSource("different-resource")),
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

  it("forks prepared Drives into writable session mounts", async () => {
    setCredentials();
    const fork = createDrive("session-fork", { parentDriveId: "prepared-drive-id" });
    const source = {
      ...createDrive("prepared-drive"),
      fork: vi.fn(async () => fork),
    };
    const get = vi.fn(async () => source);
    const module = {
      Drive: { get },
      Sandbox: { create: vi.fn() },
    };
    await expect(
      forkVercelImageMounts({
        module: module as never,
        createOptions: {},
        mounts: [
          {
            driveName: "prepared-drive",
            manifestDigest: "c".repeat(64),
            mountPath: "/eve/resources/workspace",
            region: "iad1",
            resourceKey: "workspace-key",
          },
        ],
        sandboxName: "sandbox-a",
      }),
    ).resolves.toEqual({
      forks: [
        {
          driveName: expect.stringMatching(/^eve-sbx-fork-[a-f0-9]{32}$/u),
          manifestDigest: "c".repeat(64),
          mountPath: "/eve/resources/workspace",
          resourceKey: "workspace-key",
          sourceDriveName: "prepared-drive",
        },
      ],
      mounts: { "/eve/resources/workspace": fork },
    });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: "prepared-drive" }));
    expect(source.fork).toHaveBeenCalledWith({
      name: expect.stringMatching(/^eve-sbx-fork-[a-f0-9]{32}$/u),
      signal: undefined,
    });
  });

  it("verifies exact fork bytes and removes the internal manifest", async () => {
    const source = manifestSource();
    const remove = vi.fn(async () => {});
    const sandbox = {
      fs: {
        readFile: vi.fn(async (path: string, options?: { encoding?: string }) => {
          if (path.endsWith("/.eve-resource.json")) return source;
          return options?.encoding === "utf8" ? "seed" : Buffer.from("seed");
        }),
        readdir: vi.fn(async () => [
          { isDirectory: () => false, isFile: () => true, name: ".eve-resource.json" },
          { isDirectory: () => false, isFile: () => true, name: "seed.txt" },
        ]),
        rm: remove,
      },
    };

    await expect(
      verifyVercelImageForks({
        forks: [
          {
            driveName: "session-fork",
            manifestDigest: sha256(source),
            mountPath: "/eve/resources/workspace",
            resourceKey: "workspace-key",
            sourceDriveName: "prepared-drive",
          },
        ],
        sandbox: sandbox as never,
      }),
    ).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith("/eve/resources/workspace/.eve-resource.json", {
      force: true,
      signal: undefined,
    });
  });

  it("rejects a fork whose manifest changed after preparation", async () => {
    const sandbox = {
      fs: { readFile: vi.fn(async () => manifestSource("different-resource")) },
    };
    await expect(
      verifyVercelImageForks({
        forks: [
          {
            driveName: "session-fork",
            manifestDigest: sha256(manifestSource()),
            mountPath: "/eve/resources/workspace",
            resourceKey: "workspace-key",
            sourceDriveName: "prepared-drive",
          },
        ],
        sandbox: sandbox as never,
      }),
    ).rejects.toThrow("unexpected content");
  });

  it("uses the existing fork when session start replays or races", async () => {
    setCredentials();
    const fork = createDrive("session-fork", { parentDriveId: "prepared-drive-id" });
    const source = {
      ...createDrive("prepared-drive"),
      fork: vi.fn(async () => {
        throw new Error("fork already exists");
      }),
    };
    const module = {
      Drive: { get: vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(fork) },
      Sandbox: { create: vi.fn() },
    };

    await expect(
      forkVercelImageMounts({
        module: module as never,
        createOptions: {},
        mounts: [
          {
            driveName: source.name,
            manifestDigest: "d".repeat(64),
            mountPath: "/eve/resources/skills",
            region: source.region,
            resourceKey: "skills-key",
          },
        ],
        sandboxName: "sandbox-a",
      }),
    ).resolves.toMatchObject({ mounts: { "/eve/resources/skills": fork } });
  });
});
