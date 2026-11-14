import { beforeEach, describe, expect, it, vi } from "vitest";

import { isNumber } from "../../values";
import { configurationKey } from "../config";
import type { RawContentType, RawEntry, RawSys } from "../types";
import { mirrorConfigurationKey, syncContentfulMirror } from "./sync";
import type { MirrorWorkspace } from "./sync";

const manifestPath = "/contentful/manifest.json";
const now = new Date("2026-10-08T06:00:00.000Z");

const entry = (id: string, sys: Partial<RawSys> = {}): RawEntry => ({
  fields: { slug: { "en-US": id }, title: { "en-US": `Title ${id}` } },
  sys: { id, publishedVersion: 1, version: 2, ...sys },
});

/* In-memory workspace that records every operation. */
const memoryWorkspace = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  const workspace: MirrorWorkspace = {
    listEntryFiles: vi.fn(() =>
      Promise.resolve([...files.keys()].filter((path) => path.endsWith(".md")))
    ),
    readText: vi.fn((path: string) => Promise.resolve(files.get(path) ?? null)),
    remove: vi.fn((paths: string[]) => {
      for (const path of paths) {
        files.delete(path);
      }
      return Promise.resolve();
    }),
    writeFiles: vi.fn((written: { content: string; path: string }[]) => {
      for (const { content, path } of written) {
        files.set(path, content);
      }
      return Promise.resolve();
    }),
  };
  return { files, workspace };
};

/* Content type served for every space unless a test supplies its own. */
const guideType: RawContentType = {
  description: "Help article",
  displayField: "title",
  fields: [
    { id: "title", name: "Title", required: true, type: "Symbol" },
    {
      id: "author",
      linkType: "Entry",
      name: "Author",
      type: "Link",
      validations: [{ linkContentType: ["person"] }],
    },
  ],
  name: "Guide",
  sys: { id: "guide" },
};

/* Space users per space ID, or an HTTP status every users request fails with. */
type UsersResponse = Record<string, object[]> | number;

/*
 * Serve entries, content types, and space users per space ID, recording each entry request
 * URL and each users request URL separately.
 */
const mockEntries = (
  bySpace: Record<string, RawEntry[]>,
  contentTypes: Record<string, RawContentType[]> = {},
  users: UsersResponse = {}
) => {
  const requests: URL[] = [];
  const userRequests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input));
      // Paths have the form /spaces/<space ID>/users.
      if (url.pathname.endsWith("/users")) {
        userRequests.push(url);
        if (isNumber(users)) {
          return Promise.resolve(Response.json({}, { status: users }));
        }
        const all = users[url.pathname.split("/")[2]] ?? [];
        const skip = Number(url.searchParams.get("skip"));
        const limit = Number(url.searchParams.get("limit"));
        return Promise.resolve(
          Response.json({
            items: all.slice(skip, skip + limit),
            total: all.length,
          })
        );
      }
      if (url.pathname.endsWith("/locales")) {
        return Promise.resolve(
          Response.json({ items: [{ code: "en-US", default: true }] })
        );
      }
      if (url.pathname.endsWith("/content_types")) {
        const items = contentTypes[url.pathname.split("/")[2]] ?? [guideType];
        return Promise.resolve(Response.json({ items, total: items.length }));
      }
      requests.push(url);
      // Paths have the form /spaces/<space ID>/environments/<env>/entries.
      const all = bySpace[url.pathname.split("/")[2]];
      const skip = Number(url.searchParams.get("skip"));
      const limit = Number(url.searchParams.get("limit"));
      const items = (all ?? []).slice(skip, skip + limit);
      return Promise.resolve(Response.json({ items, total: all?.length ?? 0 }));
    })
  );
  return Object.assign(requests, { userRequests });
};

const manifest = (syncedAt: string, fullSyncedAt = syncedAt) =>
  JSON.stringify({
    configuration: mirrorConfigurationKey(),
    entryCount: 1,
    fullSyncedAt,
    syncedAt,
    version: 1,
  });

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));

describe("Contentful mirror sync", () => {
  it("runs a full sync when there is no manifest, removing files for deleted entries", async () => {
    const requests = mockEntries({
      "sample-docs": [entry("guide1")],
      "sample-site": [entry("post1"), entry("post2", { archivedVersion: 3 })],
    });
    const { files, workspace } = memoryWorkspace({
      "/contentful/sample-site/deleted.json": "{}",
      "/contentful/sample-site/deleted.md": "old",
    });

    const result = await syncContentfulMirror({
      mode: "incremental",
      now,
      workspace,
    });

    expect(result).toEqual({
      entryCount: 2,
      mode: "full",
      removed: 2,
      syncedAt: now.toISOString(),
      written: 2,
    });
    expect([...files.keys()].toSorted()).toEqual([
      "/contentful/content-types.ndjson",
      manifestPath,
      "/contentful/sample-docs/guide1.json",
      "/contentful/sample-docs/guide1.md",
      "/contentful/sample-site/post1.json",
      "/contentful/sample-site/post1.md",
      "/contentful/users.ndjson",
    ]);
    expect(
      JSON.parse(files.get("/contentful/sample-site/post1.json") ?? "")
    ).toMatchObject({ entryId: "post1", slug: "post1", space: "sample-site" });
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      entryCount: 2,
      fullSyncedAt: now.toISOString(),
      syncedAt: now.toISOString(),
      version: 1,
    });
    expect(
      requests.every(
        (url) =>
          !url.searchParams.has("sys.updatedAt[gte]") &&
          url.searchParams.get("order") === "sys.createdAt,sys.id"
      )
    ).toBe(true);
    expect(new Set(requests.map((url) => url.pathname))).toEqual(
      new Set([
        "/spaces/sample-site/environments/master/entries",
        "/spaces/sample-docs/environments/master/entries",
      ])
    );
  });

  it("updates only recent changes on an incremental sync and keeps the full sync time", async () => {
    const requests = mockEntries({
      "sample-site": [entry("post1"), entry("gone", { archivedVersion: 3 })],
    });
    const { files, workspace } = memoryWorkspace({
      "/contentful/sample-site/gone.json": "{}",
      "/contentful/sample-site/gone.md": "old",
      "/contentful/sample-site/untouched.md": "kept",
      [manifestPath]: manifest(
        "2026-10-08T05:00:00.000Z",
        "2026-10-07T16:30:00.000Z"
      ),
    });

    const result = await syncContentfulMirror({
      mode: "incremental",
      now,
      workspace,
    });

    expect(result).toMatchObject({
      entryCount: 2,
      mode: "incremental",
      removed: 1,
      written: 1,
    });
    expect(
      new Set(requests.map((url) => url.searchParams.get("sys.updatedAt[gte]")))
    ).toEqual(new Set(["2026-10-08T04:50:00.000Z"]));
    expect(files.get("/contentful/sample-site/untouched.md")).toBe("kept");
    expect(files.has("/contentful/sample-site/gone.md")).toBe(false);
    expect(files.has("/contentful/sample-site/gone.json")).toBe(false);
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      fullSyncedAt: "2026-10-07T16:30:00.000Z",
      syncedAt: now.toISOString(),
    });
  });

  it("reads every page of a space", async () => {
    const posts = Array.from({ length: 150 }, (_, index) =>
      entry(`post${index}`)
    );
    const requests = mockEntries({ "sample-site": posts });
    const { workspace } = memoryWorkspace();

    const result = await syncContentfulMirror({ mode: "full", now, workspace });

    expect(result.written).toBe(150);
    expect(
      requests
        .filter((url) => url.pathname.includes("sample-site"))
        .map((url) => url.searchParams.get("skip"))
    ).toEqual(["0", "100"]);
  });

  it("runs a full sync when the manifest records a different configuration", async () => {
    const requests = mockEntries({ "sample-site": [entry("post1")] });
    const previous = JSON.stringify({
      ...JSON.parse(manifest("2026-10-08T05:00:00.000Z")),
      configuration: "previous-configuration",
    });
    const { files, workspace } = memoryWorkspace({
      "/contentful/sample-site/stale.md": "old",
      [manifestPath]: previous,
    });

    const result = await syncContentfulMirror({
      mode: "incremental",
      now,
      workspace,
    });

    expect(result).toMatchObject({ entryCount: 1, mode: "full", removed: 1 });
    expect(
      requests.some((url) => url.searchParams.has("sys.updatedAt[gte]"))
    ).toBe(false);
    expect(files.has("/contentful/sample-site/stale.md")).toBe(false);
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      configuration: mirrorConfigurationKey(),
      fullSyncedAt: now.toISOString(),
    });
  });

  it("runs a full sync on a mirror written before JSON sidecars existed", async () => {
    const requests = mockEntries({
      "sample-site": [entry("post1"), entry("post2")],
    });
    // The previous file format stored the plain configuration key and had no sidecars.
    const previous = JSON.stringify({
      ...JSON.parse(manifest("2026-10-08T05:00:00.000Z")),
      configuration: configurationKey(),
    });
    const { files, workspace } = memoryWorkspace({
      "/contentful/sample-site/post1.md": "old",
      "/contentful/sample-site/post2.md": "old",
      [manifestPath]: previous,
    });

    const result = await syncContentfulMirror({
      mode: "incremental",
      now,
      workspace,
    });

    expect(result).toMatchObject({ entryCount: 2, mode: "full", written: 2 });
    expect(
      requests.some((url) => url.searchParams.has("sys.updatedAt[gte]"))
    ).toBe(false);
    expect(files.has("/contentful/sample-site/post1.json")).toBe(true);
    expect(files.has("/contentful/sample-site/post2.json")).toBe(true);
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      configuration: mirrorConfigurationKey(),
      fullSyncedAt: now.toISOString(),
    });
  });

  it("keeps an incremental sync incremental on a mirror the current format wrote", async () => {
    const requests = mockEntries({ "sample-site": [entry("post1")] });
    const { workspace } = memoryWorkspace();
    await syncContentfulMirror({ mode: "full", now, workspace });
    requests.length = 0;

    const result = await syncContentfulMirror({
      mode: "incremental",
      now: new Date("2026-10-08T07:00:00.000Z"),
      workspace,
    });

    expect(result.mode).toBe("incremental");
    expect(
      new Set(requests.map((url) => url.searchParams.get("sys.updatedAt[gte]")))
    ).toEqual(new Set(["2026-10-08T05:50:00.000Z"]));
  });

  it("removes files for deleted entries on a requested full sync with a valid manifest", async () => {
    const requests = mockEntries({ "sample-site": [entry("post1")] });
    const { files, workspace } = memoryWorkspace({
      "/contentful/sample-site/deleted.md": "old",
      "/contentful/sample-site/post1.md": "previous",
      [manifestPath]: manifest(
        "2026-10-08T05:00:00.000Z",
        "2026-10-07T16:30:00.000Z"
      ),
    });

    const result = await syncContentfulMirror({ mode: "full", now, workspace });

    expect(result).toEqual({
      entryCount: 1,
      mode: "full",
      removed: 1,
      syncedAt: now.toISOString(),
      written: 1,
    });
    expect(
      requests.some((url) => url.searchParams.has("sys.updatedAt[gte]"))
    ).toBe(false);
    expect([...files.keys()].toSorted()).toEqual([
      "/contentful/content-types.ndjson",
      manifestPath,
      "/contentful/sample-site/post1.json",
      "/contentful/sample-site/post1.md",
      "/contentful/users.ndjson",
    ]);
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      fullSyncedAt: now.toISOString(),
    });
  });

  it("leaves the manifest unchanged when writing entry files fails", async () => {
    mockEntries({ "sample-site": [entry("post1")] });
    const previous = manifest("2026-10-08T05:00:00.000Z");
    const { files, workspace } = memoryWorkspace({ [manifestPath]: previous });
    const write = workspace.writeFiles;
    // Reject any batch containing entry files, wherever it occurs in the sync.
    workspace.writeFiles = vi.fn(
      (written: { content: string; path: string }[]) =>
        written.some(({ path }) => path.endsWith(".md"))
          ? Promise.reject(new Error("disk full"))
          : write(written)
    );

    await expect(
      syncContentfulMirror({ mode: "full", now, workspace })
    ).rejects.toThrow("disk full");
    expect(files.get(manifestPath)).toBe(previous);
  });

  it("leaves the manifest unchanged when Contentful fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 500 })))
    );
    const previous = manifest("2026-10-08T05:00:00.000Z");
    const { files, workspace } = memoryWorkspace({
      "/contentful/sample-site/kept.md": "kept",
      [manifestPath]: previous,
    });

    await expect(
      syncContentfulMirror({ mode: "full", now, workspace })
    ).rejects.toThrow("Contentful API returned 500");
    expect(files.get(manifestPath)).toBe(previous);
    expect(files.get("/contentful/sample-site/kept.md")).toBe("kept");
  });
  it("records the compacted database in the manifest after building it", async () => {
    mockEntries({ "sample-site": [entry("post1")] });
    const { files, workspace } = memoryWorkspace();
    const order: string[] = [];
    workspace.buildDatabase = vi.fn(() => {
      order.push(
        files.has(manifestPath) ? "after-manifest" : "before-manifest"
      );
      files.set("/contentful/mirror.duckdb", "db");
      return Promise.resolve();
    });

    await syncContentfulMirror({ mode: "full", now, workspace });

    expect(order).toEqual(["before-manifest"]);
    expect(files.has("/contentful/sample-site/post1.json")).toBe(true);
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      database: "mirror.duckdb",
      syncedAt: now.toISOString(),
    });
  });

  it("completes the sync without a database when the build fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockEntries({ "sample-site": [entry("post1")] });
    const { files, workspace } = memoryWorkspace({
      "/contentful/mirror.duckdb": "stale",
    });
    workspace.buildDatabase = vi.fn(() =>
      Promise.reject(new Error("duckdb missing libstdc++"))
    );

    const result = await syncContentfulMirror({ mode: "full", now, workspace });

    expect(result.written).toBe(1);
    expect(files.has("/contentful/mirror.duckdb")).toBe(false);
    const written = JSON.parse(files.get(manifestPath) ?? "");
    expect(written.syncedAt).toBe(now.toISOString());
    expect(written).not.toHaveProperty("database");
    expect(console.error).toHaveBeenCalledWith(
      "contentful.mirror_database_failed",
      { message: "duckdb missing libstdc++" }
    );
  });

  it("completes the sync when removing a failed database also fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockEntries({ "sample-site": [entry("post1")] });
    const { files, workspace } = memoryWorkspace({
      "/contentful/mirror.duckdb": "stale",
    });
    const { remove } = workspace;
    workspace.remove = vi.fn((paths: string[]) =>
      paths.includes("/contentful/mirror.duckdb")
        ? Promise.reject(new Error("drive unavailable"))
        : remove(paths)
    );
    workspace.buildDatabase = vi.fn(() =>
      Promise.reject(new Error("duckdb missing libstdc++"))
    );

    const result = await syncContentfulMirror({ mode: "full", now, workspace });

    expect(result.written).toBe(1);
    expect(workspace.remove).toHaveBeenCalledWith([
      "/contentful/mirror.duckdb",
    ]);
    const written = JSON.parse(files.get(manifestPath) ?? "");
    expect(written.syncedAt).toBe(now.toISOString());
    expect(written).not.toHaveProperty("database");
    expect(console.error).toHaveBeenCalledWith(
      "contentful.mirror_database_failed",
      { message: "duckdb missing libstdc++" }
    );
  });

  it("stores every space's content types before building the database", async () => {
    mockEntries(
      { "sample-docs": [entry("guide1")], "sample-site": [entry("post1")] },
      { "sample-site": [{ ...guideType, sys: { id: "blogPost" } }] }
    );
    const { files, workspace } = memoryWorkspace({
      [manifestPath]: manifest(
        "2026-10-08T05:00:00.000Z",
        "2026-10-07T16:30:00.000Z"
      ),
    });
    let schemaAtBuild: string | undefined;
    workspace.buildDatabase = vi.fn(() => {
      schemaAtBuild = files.get("/contentful/content-types.ndjson");
      return Promise.resolve();
    });

    await syncContentfulMirror({ mode: "incremental", now, workspace });

    const lines = (schemaAtBuild ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      lines
        .map(({ contentTypeId, space }) => `${space}/${contentTypeId}`)
        .toSorted()
    ).toEqual(["sample-docs/guide", "sample-site/blogPost"]);
    expect(lines[0]).toMatchObject({
      description: "Help article",
      displayField: "title",
      name: "Guide",
    });
    expect(lines[0].fields).toEqual([
      expect.objectContaining({ id: "title", required: true, type: "Symbol" }),
      expect.objectContaining({
        allowedContentTypeIds: ["person"],
        id: "author",
        linkType: "Entry",
        required: false,
      }),
    ]);
  });

  it("stores every space's users on full and incremental syncs, paginating and omitting emails", async () => {
    // A user with a duplicate ID straddles the page boundary; every profile carries an email.
    const siteUsers = [
      ...Array.from({ length: 149 }, (_, index) => ({
        activated: true,
        avatarUrl: "https://images.example/avatar.png",
        email: `user${index}@example.com`,
        firstName: ` First${index} `,
        lastName: `Last${index}`,
        sys: { id: `user${index}`, type: "User" },
      })),
      {
        email: "user99@example.com",
        firstName: "First99",
        sys: { id: "user99" },
      },
      {
        email: "nameless@example.com",
        firstName: " ",
        sys: { id: "nameless" },
      },
      { email: "bad@example.com", firstName: "Bad", sys: { id: "bad id" } },
    ];
    const requests = mockEntries(
      { "sample-site": [entry("post1")] },
      {},
      {
        "sample-docs": [
          {
            email: "editor@example.com",
            lastName: "Editor",
            sys: { id: "editor" },
          },
        ],
        "sample-site": siteUsers,
      }
    );
    const { files, workspace } = memoryWorkspace();
    let usersAtBuild: string | undefined;
    workspace.buildDatabase = vi.fn(() => {
      usersAtBuild = files.get("/contentful/users.ndjson");
      return Promise.resolve();
    });

    await syncContentfulMirror({ mode: "full", now, workspace });

    const text = files.get("/contentful/users.ndjson") ?? "";
    expect(usersAtBuild).toBe(text);
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("avatar");
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(151);
    for (const line of lines) {
      expect(Object.keys(line).toSorted()).toEqual(["name", "space", "userId"]);
    }
    expect(lines).toContainEqual({
      name: "First0 Last0",
      space: "sample-site",
      userId: "user0",
    });
    expect(lines).toContainEqual({
      name: "First99",
      space: "sample-site",
      userId: "user99",
    });
    expect(lines).toContainEqual({
      name: null,
      space: "sample-site",
      userId: "nameless",
    });
    expect(lines).toContainEqual({
      name: "Editor",
      space: "sample-docs",
      userId: "editor",
    });
    expect(lines.some(({ userId }) => userId === "bad id")).toBe(false);
    expect(
      requests.userRequests
        .filter((url) => url.pathname === "/spaces/sample-site/users")
        .map((url) => [
          url.searchParams.get("skip"),
          url.searchParams.get("limit"),
        ])
    ).toEqual([
      ["0", "100"],
      ["100", "100"],
    ]);
    expect(console.info).toHaveBeenCalledWith(
      "contentful.mirror_sync",
      expect.objectContaining({ userCount: 151 })
    );

    files.set("/contentful/users.ndjson", "stale\n");
    requests.userRequests.length = 0;
    const result = await syncContentfulMirror({
      mode: "incremental",
      now: new Date("2026-10-08T07:00:00.000Z"),
      workspace,
    });

    expect(result.mode).toBe("incremental");
    expect(requests.userRequests).toHaveLength(3);
    expect(files.get("/contentful/users.ndjson")).toBe(text);
  });

  it("keeps the previous users file and completes the sync when users cannot be listed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEntries({ "sample-site": [entry("post1")] }, {}, 403);
    const previousUsers =
      '{"name":"Ada Lovelace","space":"sample-site","userId":"ada"}\n';
    const { files, workspace } = memoryWorkspace({
      "/contentful/users.ndjson": previousUsers,
    });

    const result = await syncContentfulMirror({ mode: "full", now, workspace });

    expect(result.written).toBe(1);
    expect(files.get("/contentful/users.ndjson")).toBe(previousUsers);
    expect(JSON.parse(files.get(manifestPath) ?? "")).toMatchObject({
      syncedAt: now.toISOString(),
    });
    expect(console.warn).toHaveBeenCalledWith(
      "contentful.mirror_users_failed",
      { message: expect.stringContaining("Contentful API returned 403") }
    );
    expect(console.info).toHaveBeenCalledWith(
      "contentful.mirror_sync",
      expect.objectContaining({ userCount: null })
    );
  });

  it("drops users of spaces that are no longer configured when users cannot be listed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEntries({ "sample-site": [entry("post1")] }, {}, 403);
    const kept =
      '{"name":"Ada Lovelace","space":"sample-site","userId":"ada"}\n';
    const { files, workspace } = memoryWorkspace({
      "/contentful/users.ndjson": `${kept}{"name":"Grace Hopper","space":"removed-space","userId":"grace"}\nnot json\n`,
    });

    await syncContentfulMirror({ mode: "full", now, workspace });

    expect(files.get("/contentful/users.ndjson")).toBe(kept);
  });

  it("writes an empty users file before the database build when users cannot be listed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEntries({ "sample-site": [entry("post1")] }, {}, 403);
    const { files, workspace } = memoryWorkspace();
    let usersAtBuild: string | undefined;
    workspace.buildDatabase = vi.fn(() => {
      usersAtBuild = files.get("/contentful/users.ndjson");
      return Promise.resolve();
    });

    await syncContentfulMirror({ mode: "full", now, workspace });

    expect(usersAtBuild).toBe("");
    expect(console.warn).toHaveBeenCalledWith(
      "contentful.mirror_users_failed",
      expect.anything()
    );
  });

  it("fails the sync when it is aborted while listing users", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    mockEntries({ "sample-site": [entry("post1")] });
    const respond = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).includes("/users")) {
        controller.abort(new Error("sync cancelled"));
        return Promise.reject(new Error("sync cancelled"));
      }
      return respond ? respond(input, init) : Promise.reject(new Error("no"));
    });
    const previous = manifest("2026-10-08T05:00:00.000Z");
    const { files, workspace } = memoryWorkspace({ [manifestPath]: previous });

    await expect(
      syncContentfulMirror({
        mode: "full",
        now,
        signal: controller.signal,
        workspace,
      })
    ).rejects.toThrow("sync cancelled");
    expect(warn).not.toHaveBeenCalled();
    expect(files.get(manifestPath)).toBe(previous);
  });
});
