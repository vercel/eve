import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../json";
import { contentfulPublishInputSchema } from "./input-schemas";
import {
  executeContentfulPublication,
  prepareContentfulPublication,
} from "./publication";
import { formatContentfulPublicationPreview } from "./publication-message";
import { createCmaFake, link } from "./testing/cma";
import type { CmaResource } from "./testing/cma";

const GRAPH_LIMIT_ERROR = /limited|exceeds/u;
const input = (ids = ["guide"], space: "docs" | "site" = "docs") => ({
  entries: ids.map((entryId) => ({ entryId, expectedVersion: 7 })),
  space,
});
const entry = (
  id: string,
  type = "codeBlock",
  refs: JsonValue[] = []
): CmaResource => ({
  fields: {
    refs: { "en-US": refs },
    slug: { "en-US": id },
    title: { "en-US": id },
  },
  sys: { contentType: link(type, "ContentType"), id, version: 7 },
});
const asset = (id = "image"): CmaResource => ({
  fields: { file: { "en-US": { url: "//images.ctfassets.net/file.png" } } },
  sys: { id, version: 4 },
});
const fixture = () => createCmaFake({ entries: [entry("guide", "guide")] });
type Fixture = ReturnType<typeof fixture>;
const writtenIds = (f: Fixture) => f.writes().map(({ id }) => id);

const publish = async (value = input()) =>
  executeContentfulPublication(
    await prepareContentfulPublication(value),
    () => {}
  );

describe("Contentful publication plans", () => {
  it.each(["docs", "site"] as const)(
    "preflights 20 requested entries in %s and writes exact versions",
    async (space) => {
      const f = fixture();
      const ids = Array.from({ length: 20 }, (_, i) => `page-${i}`);
      for (const id of ids) {
        f.entries.set(id, entry(id, space === "docs" ? "guide" : "blogPost"));
      }
      const controller = new AbortController();
      const plan = await prepareContentfulPublication(
        input(ids, space),
        controller.signal
      );
      expect(f.writes()).toHaveLength(0);
      const result = await executeContentfulPublication(
        plan,
        () => {},
        controller.signal
      );
      expect(result.complete).toBe(true);
      expect(result.results.map((r) => r.entryId)).toEqual(ids);
      expect(
        f
          .requests()
          .slice(0, 40)
          .every(({ method }) => method === "GET")
      ).toBe(true);
      expect(writtenIds(f)).toEqual(ids);
      for (const { action, body, headers, init, url } of f.writes()) {
        expect(url.origin).toBe("https://api.contentful.com");
        expect(url.pathname).toContain(
          `/spaces/${space === "docs" ? "sample-docs" : "sample-site"}/environments/master/entries/`
        );
        expect(action).toBe("published");
        expect(headers.get("X-Contentful-Version")).toBe("7");
        expect(init.signal).toBe(controller.signal);
        expect(body).toBeUndefined();
      }
    }
  );

  it("plans nested rich-text references and processed assets before the page", async () => {
    const f = fixture();
    f.entries.set(
      "guide",
      entry("guide", "guide", [
        {
          content: [],
          data: { target: link("faq") },
          nodeType: "embedded-entry-block",
        },
        link("image", "Asset"),
      ])
    );
    f.entries.set("faq", entry("faq", "faq", [link("tabs")]));
    f.entries.set(
      "tabs",
      entry("tabs", "codeBlockTabs", [link("code"), link("image", "Asset")])
    );
    f.entries.set("code", entry("code"));
    f.assets.set("image", asset());
    const plan = await prepareContentfulPublication(input());
    expect(plan.items.map((i) => i.id)).toEqual([
      "code",
      "image",
      "tabs",
      "faq",
      "guide",
    ]);
    expect(plan.requiresApproval).toBe(true);
    expect(formatContentfulPublicationPreview(plan).text).toContain(
      "/assets/image"
    );
    const result = await executeContentfulPublication(plan, () => {});
    expect(result.results.map((r) => r.outcome)).toEqual(
      Array.from({ length: 5 }, () => "published")
    );
    expect(result.results[1]).toMatchObject({
      assetId: "image",
      entryId: null,
      role: "dependency",
      version: 5,
    });
    expect(f.writes()[1].url.pathname).toContain("/assets/image/published");
  });

  it("keeps pending edits on live references for component-only publication", async () => {
    const f = fixture();
    f.entries.set(
      "guide",
      entry("guide", "codeBlockTabs", [link("faq"), link("image", "Asset")])
    );
    const live = entry("faq", "faq", [link("nonexistent")]);
    live.sys.publishedVersion = 3;
    f.entries.set("faq", live);
    const image = asset();
    image.sys.publishedVersion = 2;
    f.assets.set("image", image);
    const plan = await prepareContentfulPublication(input());
    expect(plan.items.map((i) => i.id)).toEqual(["guide"]);
    expect(plan.liveReferences).toHaveLength(2);
    // Saving a new draft edit does not change the version being retained live.
    live.sys.version = 8;
    const completed1 = await executeContentfulPublication(plan, () => {});
    expect(completed1.complete).toBe(true);
    expect(f.writes()).toHaveLength(1);
    expect(live.sys.publishedVersion).toBe(3);
  });

  it.each(["docs", "site"] as const)(
    "includes changed nested entries and assets for pages in %s",
    async (space) => {
      const f = fixture();
      f.entries.set(
        "guide",
        entry("guide", space === "docs" ? "guide" : "blogPost", [
          link("tabs"),
          link("code"),
        ])
      );
      const tabs = entry("tabs", "codeBlockTabs", [link("code")]);
      // Unchanged parent still exposes edited children.
      tabs.sys.publishedVersion = 6;
      const code = entry("code", "codeBlock", [
        link("new"),
        link("image", "Asset"),
      ]);
      code.sys.publishedVersion = 3;
      const image = asset();
      image.sys.publishedVersion = 2;
      f.entries.set("tabs", tabs);
      f.entries.set("code", code);
      f.entries.set("new", entry("new"));
      f.assets.set("image", image);
      const plan = await prepareContentfulPublication(input(["guide"], space));
      expect(plan.items.map(({ id, status }) => [id, status])).toEqual([
        ["new", "draft"],
        ["image", "changed"],
        ["code", "changed"],
        ["guide", "draft"],
      ]);
      expect(plan.liveReferences).toMatchObject([
        { expectedVersion: 7, id: "tabs", publishedVersion: 6 },
      ]);
      expect(plan.requiresApproval).toBe(true);
      const completed2 = await executeContentfulPublication(plan, () => {});
      expect(completed2.complete).toBe(true);
      expect(writtenIds(f)).toEqual(["new", "image", "code", "guide"]);
    }
  );

  it.each([
    ["component", "guide"],
    ["guide", "component"],
  ])(
    "includes changed references regardless of mixed batch order %j",
    async (...ids) => {
      const f = fixture();
      f.entries.set("component", entry("component", "faq", [link("code")]));
      const code = entry("code");
      code.sys.publishedVersion = 3;
      f.entries.set("code", code);
      const plan = await prepareContentfulPublication(input(ids));
      expect(plan.requiresApproval).toBe(true);
      expect(plan.items.find(({ id }) => id === "code")).toMatchObject({
        role: "dependency",
        status: "changed",
      });
      for (const id of ids) {
        expect(
          f.requests().filter((request) => request.id === id)
        ).toHaveLength(1);
      }
    }
  );

  it("retains an unrequested changed page without traversing or publishing its edits", async () => {
    const f = fixture();
    f.entries.set("guide", entry("guide", "guide", [link("topic")]));
    const topic = entry("topic", "topic", [link("missing")]);
    topic.sys.publishedVersion = 3;
    f.entries.set("topic", topic);
    const plan = await prepareContentfulPublication(input());
    expect(plan.items.map(({ id }) => id)).toEqual(["guide"]);
    expect(plan.liveReferences).toMatchObject([
      { id: "topic", publishedVersion: 3 },
    ]);
    const completed3 = await executeContentfulPublication(plan, () => {});
    expect(completed3.complete).toBe(true);
    expect(topic.sys.publishedVersion).toBe(3);
  });

  it("finds changed references even when the requested page itself is already published", async () => {
    const f = fixture();
    const root = entry("guide", "guide", [link("code")]);
    root.sys.publishedVersion = 6;
    const code = entry("code");
    code.sys.publishedVersion = 3;
    f.entries.set("guide", root);
    f.entries.set("code", code);
    const plan = await prepareContentfulPublication(input());
    // Approval is decided after traversal, so the edited reference requires it.
    expect(plan.requiresApproval).toBe(true);
    const result = await executeContentfulPublication(plan, () => {});
    expect(result.results.map(({ id, outcome }) => [id, outcome])).toEqual([
      ["code", "published"],
      ["guide", "alreadyPublished"],
    ]);
    expect(f.writes()).toHaveLength(1);
  });

  it("publishes explicitly requested changed references before their parents", async () => {
    const f = fixture();
    f.entries.set("guide", entry("guide", "guide", [link("code")]));
    const code = entry("code");
    code.sys.publishedVersion = 2;
    f.entries.set("code", code);
    const completed4 = await publish(input(["guide", "code"]));
    expect(completed4.results.map((r) => [r.id, r.role])).toEqual([
      ["code", "requested"],
      ["guide", "requested"],
    ]);
  });

  it("allows explicitly requested linked pages and orders them first", async () => {
    const f = fixture();
    f.entries.set("guide", entry("guide", "guide", [link("topic")]));
    f.entries.set("topic", entry("topic", "topic"));
    const completed5 = await publish(input(["guide", "topic"]));
    expect(completed5.results.map((r) => r.id)).toEqual(["topic", "guide"]);
  });

  it("blocks unpublished pages that were not requested", async () => {
    const f = fixture();
    f.entries.set("guide", entry("guide", "guide", [link("topic")]));
    f.entries.set("topic", entry("topic", "topic"));
    await expect(publish()).rejects.toThrow("must be explicitly included");
    expect(f.writes()).toHaveLength(0);
  });

  it("deduplicates dependencies across roots while distinguishing Entry and Asset IDs", async () => {
    const f = fixture();
    for (const id of ["guide", "second"]) {
      f.entries.set(
        id,
        entry(id, "guide", [link("same"), link("same", "Asset"), link("same")])
      );
    }
    f.entries.set("same", entry("same"));
    f.assets.set("same", asset("same"));
    const result = await publish(input(["guide", "second"]));
    expect(result.results).toHaveLength(4);
    expect(f.writes()).toHaveLength(4);
  });

  it("skips already-published requested versions", async () => {
    const f = fixture();
    const raw = entry("guide", "guide");
    raw.sys.publishedVersion = 6;
    f.entries.set("guide", raw);
    const plan = await prepareContentfulPublication(input());
    expect(plan.requiresApproval).toBe(false);
    expect(await executeContentfulPublication(plan, () => {})).toMatchObject({
      complete: true,
      nothingToPublish: true,
      results: [{ id: "guide", outcome: "alreadyPublished", version: 7 }],
    });
    expect(f.writes()).toHaveLength(0);
  });

  it("does not report nothingToPublish for interrupted no-op results", async () => {
    const f = fixture();
    for (const id of ["guide", "second"]) {
      const raw = entry(id, "guide");
      raw.sys.publishedVersion = 6;
      f.entries.set(id, raw);
    }
    const plan = await prepareContentfulPublication(input(["guide", "second"]));
    const controller = new AbortController();
    const result = await executeContentfulPublication(
      plan,
      () => controller.abort(),
      controller.signal
    );
    expect(result).toMatchObject({
      complete: false,
      nothingToPublish: false,
      results: [{ outcome: "alreadyPublished" }, { outcome: "notAttempted" }],
    });
    expect(f.writes()).toHaveLength(0);
  });

  it.each([
    ["missing", "Contentful API returned 404"],
    ["archived", "Entry:code is archived"],
    ["missing asset", "Contentful API returned 404"],
    ["archived asset", "Asset:image is archived"],
    ["unprocessed asset", "Asset image is not processed"],
    ["malformed", "unsupported or malformed reference"],
    ["resource", "unsupported or malformed reference"],
    ["cycle", "dependency cycle at Entry:"],
    ["version", "Entry:guide version has changed"],
    ["type", "Entry:code has no valid content type"],
    ["identity", "Entry:code returned an invalid identity"],
  ] as const)("blocks %s before any write", async (failure, message) => {
    const f = fixture();
    const root = entry("guide", "guide", [link("code")]);
    const code = entry("code");
    f.entries.set("guide", root);
    f.entries.set("code", code);
    if (failure === "missing") {
      f.entries.delete("code");
    }
    if (failure === "archived") {
      code.sys.archivedVersion = 6;
    }
    if (failure.endsWith("asset")) {
      root.fields.refs["en-US"] = [link("image", "Asset")];
    }
    if (failure === "archived asset") {
      const image = asset();
      image.sys.archivedVersion = 3;
      f.assets.set("image", image);
    }
    if (failure === "unprocessed asset") {
      const image = asset();
      image.sys.publishedVersion = 2;
      image.fields.file["en-US"] = { upload: "https://example.com/new.png" };
      f.assets.set("image", image);
    }
    if (failure === "malformed") {
      root.fields.refs["en-US"] = [link("../escape")];
    }
    if (failure === "resource") {
      root.fields.refs["en-US"] = [
        {
          sys: {
            linkType: "Contentful:Entry",
            type: "ResourceLink",
            urn: "crn:contentful:::content:spaces/elsewhere/entries/id",
          },
        },
      ];
    }
    if (failure === "cycle") {
      code.fields.refs["en-US"] = [link("guide")];
    }
    if (failure === "version") {
      root.sys.version = 8;
    }
    if (failure === "type") {
      code.sys.contentType = link("../bad", "ContentType");
    }
    if (failure === "identity") {
      f.entries.set("code", entry("different"));
    }
    await expect(publish()).rejects.toThrow(message);
    expect(f.writes()).toHaveLength(0);
  });

  // Each change is a state the CMA can actually reach: saves bump `version`,
  // publishing sets `publishedVersion` to the saved version and bumps it again,
  // unpublishing drops `publishedVersion`, and archiving requires an unpublished
  // entry and records `archivedVersion`.
  it.each([
    ["dependency edit", "guide", "Entry:code version has changed"],
    ["root edit", "guide", "Entry:guide version has changed"],
    ["asset edit", "guide", "Asset:image version has changed"],
    ["live edited", "guide", "Entry:live retained reference has changed"],
    ["live unpublished", "guide", "Entry:live retained reference has changed"],
    ["live republished", "guide", "Entry:live retained reference has changed"],
    // Component-only plans pin only the published version of a live reference.
    [
      "live republished",
      "codeBlockTabs",
      "Entry:live retained reference has changed",
    ],
    ["live archived", "guide", "Entry:live is archived"],
  ] as const)(
    "invalidates the frozen %s plan for a %s root",
    async (change, rootType, message) => {
      const f = fixture();
      const root = entry("guide", rootType, [
        link("code"),
        link("live"),
        link("image", "Asset"),
      ]);
      const code = entry("code");
      const live = entry("live");
      live.sys.publishedVersion = 6;
      const image = asset();
      f.entries.set("guide", root);
      f.entries.set("code", code);
      f.entries.set("live", live);
      f.assets.set("image", image);
      const plan = await prepareContentfulPublication(input());
      expect(plan.liveReferences).toMatchObject([
        {
          expectedVersion: rootType === "guide" ? 7 : null,
          id: "live",
          publishedVersion: 6,
        },
      ]);
      if (change === "dependency edit") {
        code.sys.version = 8;
      }
      if (change === "root edit") {
        root.sys.version = 8;
        root.fields.refs["en-US"] = [link("new-dependency")];
      }
      if (change === "asset edit") {
        image.sys.version = 5;
      }
      if (change === "live edited") {
        live.sys.version = 8;
      }
      if (change === "live unpublished") {
        live.sys.publishedVersion = undefined;
        live.sys.version = 8;
      }
      if (change === "live republished") {
        live.sys.publishedVersion = 8;
        live.sys.version = 9;
      }
      if (change === "live archived") {
        live.sys.publishedVersion = undefined;
        live.sys.archivedVersion = 8;
        live.sys.version = 9;
      }
      await expect(
        executeContentfulPublication(plan, () => {})
      ).rejects.toThrow(message);
      expect(f.writes()).toHaveLength(0);
      expect(
        f.requests().some((request) => request.id === "new-dependency")
      ).toBe(false);
    }
  );

  it("rejects a missing reference in another locale before writing", async () => {
    const f = fixture();
    const raw = entry("guide", "guide");
    raw.fields.refs.fr = [link("ignored")];
    f.entries.set("guide", raw);
    await expect(publish()).rejects.toThrow("404");
    expect(f.writes()).toHaveLength(0);
  });

  it.each(["publications", "depth", "targets", "per-entry"])(
    "bounds graph %s without writes",
    async (bound) => {
      const f = fixture();
      if (bound === "depth") {
        for (let i = 0; i < 22; i += 1) {
          f.entries.set(
            `node-${i}`,
            entry(
              `node-${i}`,
              "codeBlock",
              i < 21 ? [link(`node-${i + 1}`)] : []
            )
          );
        }
        f.entries.set("guide", entry("guide", "guide", [link("node-0")]));
      } else {
        const count = bound === "publications" ? 100 : 501;
        const refs = Array.from({ length: count }, (_, i) => link(`node-${i}`));
        f.entries.set(
          "guide",
          entry(
            "guide",
            "guide",
            bound === "targets" ? refs.slice(0, 500) : refs
          )
        );
        for (let i = 0; i < count; i += 1) {
          const raw = entry(`node-${i}`);
          if (bound !== "publications") {
            raw.sys.publishedVersion = 6;
          }
          f.entries.set(`node-${i}`, raw);
        }
      }
      await expect(publish()).rejects.toThrow(GRAPH_LIMIT_ERROR);
      expect(f.writes()).toHaveLength(0);
    }
  );
});

describe("publication failure and recovery", () => {
  it.each([
    [403, "Contentful API returned 403"],
    [409, "Contentful API returned 409"],
    [422, "Contentful API returned 422"],
    [429, "Contentful API returned 429"],
    [500, "Contentful API returned 500"],
    ["network", "Connection lost"],
    ["wrong id", "unexpected publication response"],
    ["wrong version", "unexpected publication response"],
    ["wrong publishedVersion", "unexpected publication response"],
    ["cancel", "Cancelled"],
  ] as const)(
    "stops on %s and retains successful dependencies",
    async (failure, detail) => {
      const f = fixture();
      f.entries.set("guide", entry("guide", "guide", [link("code")]));
      f.entries.set("code", entry("code"));
      f.entries.set("last", entry("last"));
      const controller = new AbortController();
      const plan = await prepareContentfulPublication(input(["guide", "last"]));
      const record = vi.fn();
      f.failWhen(
        ({ action, id }) => action === "published" && id === "guide",
        (): Response => {
          if (failure === "network") {
            throw new Error("Connection lost");
          }
          if (failure === "cancel") {
            controller.abort();
            throw new DOMException("Cancelled", "AbortError");
          }
          // Each malformed response breaks exactly one confirmation check.
          if (failure === "wrong id") {
            return Response.json({
              sys: { id: "wrong", publishedVersion: 7, version: 8 },
            });
          }
          if (failure === "wrong version") {
            return Response.json({
              sys: { id: "guide", publishedVersion: 7, version: 9 },
            });
          }
          if (failure === "wrong publishedVersion") {
            return Response.json({
              sys: { id: "guide", publishedVersion: 6, version: 8 },
            });
          }
          return Response.json(
            { message: "Publication rejected" },
            { status: failure }
          );
        }
      );
      const result = await executeContentfulPublication(
        plan,
        record,
        controller.signal
      );
      expect(result.complete).toBe(false);
      expect(result.results.map((r) => r.outcome)).toEqual([
        "published",
        "failed",
        "notAttempted",
      ]);
      // The catch block replaces the pre-write placeholder with the cause.
      expect(result.results[1].error).toContain(detail);
      expect(result.results[1].error).toContain(
        "No remaining items were attempted"
      );
      expect(record).toHaveBeenCalled();
      expect(f.writes()).toHaveLength(2);
      f.fetch.mockClear();
      expect(await executeContentfulPublication(plan, record)).toEqual(result);
      expect(f.fetch).not.toHaveBeenCalled();
    }
  );

  it("prevents duplicate writes after a lost progress checkpoint by checking frozen versions", async () => {
    const f = fixture();
    const plan = await prepareContentfulPublication(input());
    const saved = structuredClone(plan);
    await executeContentfulPublication(plan, () => {});
    f.fetch.mockClear();
    await expect(executeContentfulPublication(saved, () => {})).rejects.toThrow(
      "version has changed"
    );
    expect(f.writes()).toHaveLength(0);
  });

  it("honors cancellation during read-only preparation and verification", async () => {
    const f = fixture();
    const plan = await prepareContentfulPublication(input());
    const controller = new AbortController();
    controller.abort();
    f.fetch.mockClear();
    await expect(
      prepareContentfulPublication(input(), controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      executeContentfulPublication(plan, () => {}, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("reports cancellation between writes without claiming a write was attempted", async () => {
    const f = fixture();
    f.entries.set("last", entry("last"));
    const plan = await prepareContentfulPublication(input(["guide", "last"]));
    const controller = new AbortController();
    const result = await executeContentfulPublication(
      plan,
      (p) => {
        if (p.results[0]?.outcome === "published") {
          controller.abort();
        }
      },
      controller.signal
    );
    expect(result.results.map((r) => r.outcome)).toEqual([
      "published",
      "notAttempted",
    ]);
    expect(f.writes()).toHaveLength(1);
  });

  it.each([400, 403, 404, 429, 500])(
    "surfaces read API errors %s without publishing",
    async (status) => {
      const f = fixture();
      f.failWhen(() => true, status);
      await expect(publish()).rejects.toThrow(String(status));
      expect(f.writes()).toHaveLength(0);
    }
  );

  const INVALID_ENTRY_ID = "Invalid string: must match pattern";
  it.each<[JsonValue, string]>([
    [{ ...input(), space: "other" }, "Space is not configured."],
    [
      { ...input(), entries: [] },
      "Too small: expected array to have >=1 items",
    ],
    [
      input(Array.from({ length: 21 }, () => "guide")),
      "Too big: expected array to have <=20 items",
    ],
    [input(["guide", "guide"]), "Duplicate entry IDs are not allowed."],
    [input(["../escape"]), INVALID_ENTRY_ID],
    [input(["id?x=1"]), INVALID_ENTRY_ID],
    [input(["id/child"]), INVALID_ENTRY_ID],
    [{ ...input(), url: "https://example.com" }, 'Unrecognized key: \\"url\\"'],
    [{ ...input(), method: "DELETE" }, 'Unrecognized key: \\"method\\"'],
    [
      { ...input(), entries: [{ entryId: "guide", expectedVersion: 0 }] },
      "Too small: expected number to be >=1",
    ],
  ])(
    "rejects invalid inputs and endpoint escape attempts: %j",
    async (value, message) => {
      const f = fixture();
      expect(contentfulPublishInputSchema.safeParse(value).success).toBe(false);
      await expect(prepareContentfulPublication(value)).rejects.toThrow(
        message
      );
      expect(f.fetch).not.toHaveBeenCalled();
    }
  );
});

describe("additional publication boundaries", () => {
  it.each([
    [
      { version: undefined },
      "Entry:guide returned an invalid identity or version",
    ],
    [{ version: 1.5 }, "Entry:guide returned an invalid identity or version"],
    [
      { publishedVersion: -1 },
      "Entry:guide returned an invalid published version",
    ],
    [
      { publishedVersion: 7 },
      "Entry:guide returned an invalid published version",
    ],
    [
      { contentType: { sys: { id: 123 } } },
      "Entry:guide has no valid content type",
    ],
  ] as const)(
    "rejects malformed Contentful metadata: %j",
    async (sys, message) => {
      const f = fixture();
      f.intercept(
        ({ id }) => id === "guide",
        () =>
          Response.json({
            ...entry("guide", "guide"),
            sys: { ...entry("guide", "guide").sys, ...sys },
          })
      );
      await expect(publish()).rejects.toThrow(message);
      expect(f.writes()).toHaveLength(0);
    }
  );
  it("keeps the complete maximum-size preview in one card below Slack's message limit", async () => {
    const f = fixture();
    const refs = Array.from({ length: 99 }, (_, i) =>
      link(`${i}`.padEnd(128, "x"))
    );
    f.entries.set("guide", entry("guide", "guide", refs));
    for (const ref of refs) {
      const raw = entry(ref.sys.id);
      raw.fields.title["en-US"] = "title".repeat(1000);
      f.entries.set(ref.sys.id, raw);
    }
    const plan = await prepareContentfulPublication(input());
    const preview = formatContentfulPublicationPreview(plan);
    expect(plan.items).toHaveLength(100);
    expect(preview.text.length).toBeLessThan(38_000);
    expect(preview.blocks.length).toBeLessThanOrEqual(50);
    const cards = preview.blocks.filter((block) => block.type === "container");
    expect(cards).toHaveLength(1);
    expect(cards[0].child_blocks.length).toBeLessThanOrEqual(10);
    for (const ref of refs) {
      expect(preview.text).toContain(ref.sys.id);
      expect(JSON.stringify(preview.blocks)).toContain(ref.sys.id);
    }
  });
});

describe("entry-wide locale publication", () => {
  it("includes and deduplicates other-locale RichText dependencies in the approved scope", async () => {
    const f = fixture();
    const page = entry("guide", "guide", [link("translated")]);
    page.fields.body = {
      "fr-FR": {
        content: [
          {
            data: { target: link("translated") },
            nodeType: "embedded-entry-block",
          },
        ],
        nodeType: "document",
      },
    };
    f.entries.set("guide", page);
    f.entries.set("translated", entry("translated"));
    const plan = await prepareContentfulPublication(input());
    expect(plan.items.map(({ id }) => id)).toEqual(["translated", "guide"]);
    expect(JSON.stringify(formatContentfulPublicationPreview(plan))).toContain(
      "translated"
    );
    expect(JSON.stringify(formatContentfulPublicationPreview(plan))).toContain(
      "all locales"
    );
    expect(f.writes()).toEqual([]);
  });

  it("rejects an archived reference found only in another locale", async () => {
    const f = fixture();
    const page = entry("guide", "guide");
    page.fields.refs["fr-FR"] = [link("archived")];
    f.entries.set("guide", page);
    const archived = entry("archived");
    archived.sys.archivedVersion = 4;
    f.entries.set("archived", archived);
    await expect(prepareContentfulPublication(input())).rejects.toThrow(
      "archived"
    );
    expect(f.writes()).toEqual([]);
  });

  it.each(["guide", "codeBlock"])(
    "preserves live reference boundaries for %s across locales",
    async (type) => {
      const f = fixture();
      const root = entry("guide", type);
      root.fields.refs["fr-FR"] = [link("other-page"), link("live-component")];
      f.entries.set("guide", root);
      const page = entry("other-page", "guide", [link("not-traversed")]);
      page.sys.publishedVersion = 3;
      f.entries.set("other-page", page);
      const component = entry("live-component");
      component.sys.publishedVersion = 3;
      f.entries.set("live-component", component);
      const plan = await prepareContentfulPublication(input());
      expect(plan.items.map(({ id }) => id)).toEqual(
        type === "guide" ? ["live-component", "guide"] : ["guide"]
      );
      expect(plan.liveReferences).toContainEqual(
        expect.objectContaining({ id: "other-page" })
      );
      expect(f.requests().some(({ id }) => id === "not-traversed")).toBe(false);
    }
  );

  it("requires an explicitly requested draft page even when only another locale references it", async () => {
    const f = fixture();
    const page = entry("guide", "guide");
    page.fields.refs["fr-FR"] = [link("draft-page")];
    f.entries.set("guide", page);
    f.entries.set("draft-page", entry("draft-page", "guide"));
    await expect(prepareContentfulPublication(input())).rejects.toThrow(
      "explicitly included"
    );
    expect(f.writes()).toEqual([]);
  });

  it.each([true, false])(
    "validates populated asset locales without requiring optional translations: processed %s",
    async (processed) => {
      const f = fixture();
      f.entries.set("guide", entry("guide", "guide", [link("image", "Asset")]));
      const image = asset();
      image.fields.file = { "fr-FR": { url: "//images.ctfassets.net/fr.png" } };
      if (!processed) {
        image.fields.file["de-DE"] = {
          upload: "https://example.com/pending.png",
        };
      }
      f.assets.set("image", image);
      if (processed) {
        const plan = await prepareContentfulPublication(input());
        expect(plan.items.map(({ id }) => id)).toEqual(["image", "guide"]);
      } else {
        await expect(prepareContentfulPublication(input())).rejects.toThrow(
          "not processed"
        );
      }
      expect(f.writes()).toEqual([]);
    }
  );
});
