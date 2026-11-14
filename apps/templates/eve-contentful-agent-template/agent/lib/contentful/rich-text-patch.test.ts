import { describe, expect, it } from "vitest";

import type { JsonObject } from "../json";
import { richTextBlockHash } from "./content";
import { readEntryContent } from "./entries";
import type { ContentfulUpdateInput } from "./input-schemas";
import { QUERY_SPACES } from "./model";
import { prepareContentfulPublication } from "./publication";
import { contentType, createCmaFake, link } from "./testing/cma";
import type { CmaResource } from "./testing/cma";
import { updateContentfulFields } from "./update";

/* The configured protected page body, plus an unprotected component body. */
const PROTECTED_PAGE_BODY = {
  contentTypeId: "guide",
  fieldId: "main",
  space: "docs",
} as const;
const COMPONENT_BODY = {
  contentTypeId: "callout",
  fieldId: "content",
  space: "docs",
} as const;

type JsonValue =
  ContentfulUpdateInput["entries"][number]["changes"][number]["value"];
type Change = ContentfulUpdateInput["entries"][number]["changes"][number];

const text = (value: string, marks: string[] = []) => ({
  data: {},
  marks: marks.map((type) => ({ type })),
  nodeType: "text",
  value,
});
const node = (
  nodeType: string,
  content: JsonValue[] = [],
  data: Record<string, JsonValue> = {}
) => ({ content, data, nodeType });
const paragraph = (...content: JsonValue[]) => node("paragraph", content);
const heading = (value: string) => node("heading-2", [text(value)]);
const embed = (id: string) =>
  node("embedded-entry-block", [], { target: link(id) });
const doc = (...content: JsonValue[]) => node("document", content);

const intro = paragraph(text("Water with "), text("drip line", ["code"]));
const setup = heading("Set up the project");
const body = doc(intro, setup, embed("codeSample"), paragraph(text("Done.")));
const blocks = body.content;
const hash = (index: number) => richTextBlockHash(blocks[index]);

/* A help guide, whose main field is a protected page body; null omits it. */
const guide = (main: JsonValue | null = body): CmaResource => ({
  fields: {
    title: { "en-US": "Guide" },
    ...(!(main === null) && { main: { "de-DE": "keep", "en-US": main } }),
  },
  sys: {
    contentType: link("guide", "ContentType"),
    id: "guide",
    publishedVersion: 6,
    version: 7,
  },
});

const cma = (entry = guide()) =>
  createCmaFake({
    contentTypes: [
      contentType("guide", [
        { id: "title", name: "Title", type: "Symbol" },
        { id: "main", name: "Main", required: true, type: "RichText" },
      ]),
      contentType("codeBlock", []),
    ],
    entries: [
      entry,
      {
        fields: {},
        sys: {
          contentType: link("codeBlock", "ContentType"),
          id: "codeSample",
          version: 1,
        },
      },
      {
        fields: {},
        sys: {
          contentType: link("codeBlock", "ContentType"),
          id: "otherSample",
          version: 1,
        },
      },
    ],
  });

const patch = (value: JsonValue, fieldId = "main"): ContentfulUpdateInput => ({
  entries: [
    {
      changes: [{ fieldId, operation: "patch", value }],
      entryId: "guide",
      expectedVersion: 7,
    },
  ],
  space: "docs",
});

const savedMain = (fake: ReturnType<typeof cma>) => {
  const [write] = fake.writes();
  // SAFETY: These fixtures save the main localized field; missing or malformed write output makes the test fail.
  return (write.body as { fields: { main: JsonObject } }).fields.main;
};

const textEdit = (find: string, replace: string) => ({
  find,
  hash: hash(1),
  index: 1,
  replace,
  type: "replaceText",
});

describe("RichText body patches", () => {
  it("replaces text in one block of a protected body and saves without publishing", async () => {
    const fake = cma();
    expect(
      await updateContentfulFields(
        patch({
          edits: [
            {
              find: "Set up",
              hash: hash(1),
              index: 1,
              replace: "Configure",
              type: "replaceText",
            },
          ],
          embeds: null,
        })
      )
    ).toMatchObject({
      complete: true,
      results: [{ outcome: "updated", status: "changed", version: 8 }],
    });
    expect(fake.writes().map(({ method }) => method)).toEqual(["PUT"]);
    expect(savedMain(fake)).toEqual({
      "de-DE": "keep",
      "en-US": doc(
        intro,
        heading("Configure the project"),
        embed("codeSample"),
        paragraph(text("Done."))
      ),
    });
  });

  it.each<Change>([
    { fieldId: "main", operation: "set", value: body },
    { fieldId: "main", operation: "unset", value: null },
  ])(
    "still blocks whole-value writes to protected bodies: %j",
    async (change) => {
      const fake = cma();
      await expect(
        updateContentfulFields({
          entries: [
            { changes: [change], entryId: "guide", expectedVersion: 7 },
          ],
          space: "docs",
        })
      ).rejects.toThrow(
        "RichText writes are not supported for docs/guide/main. Edit this body with operation=patch."
      );
      expect(fake.writes()).toHaveLength(0);
    }
  );

  it("matches several text edits on one block against the block as read", async () => {
    const fake = cma();

    await expect(
      updateContentfulFields(
        patch({
          edits: [textEdit("Set up", "Configure"), textEdit("Configure", "x")],
          embeds: null,
        })
      )
    ).rejects.toThrow("Block 1: find text was not found.");
    await expect(
      updateContentfulFields(
        patch({
          edits: [textEdit("Set up", "a"), textEdit("up the", "b")],
          embeds: null,
        })
      )
    ).rejects.toThrow("Block 1: two replaceText edits overlap.");
    expect(fake.writes()).toHaveLength(0);
    await updateContentfulFields(
      patch({
        edits: [textEdit("project", "app"), textEdit("Set up", "Configure")],
        embeds: null,
      })
    );
    expect(savedMain(fake)["en-US"]).toEqual(
      doc(
        intro,
        heading("Configure the app"),
        embed("codeSample"),
        paragraph(text("Done."))
      )
    );
  });

  it("addresses every edit to the document as read", async () => {
    const fake = cma();
    await updateContentfulFields(
      patch({
        edits: [
          {
            afterHash: null,
            afterIndex: null,
            nodes: [heading("Overview")],
            type: "insertBlocks",
          },
          {
            hashes: [hash(0)],
            index: 0,
            nodes: [paragraph(text("Water in the morning."))],
            type: "replaceBlocks",
          },
          {
            afterHash: hash(3),
            afterIndex: 3,
            nodes: [paragraph(text("Next steps."))],
            type: "insertBlocks",
          },
          { hashes: [hash(3)], index: 3, nodes: [], type: "replaceBlocks" },
        ],
        embeds: null,
      })
    );
    expect(savedMain(fake)["en-US"]).toEqual(
      doc(
        heading("Overview"),
        paragraph(text("Water in the morning.")),
        setup,
        embed("codeSample"),
        paragraph(text("Next steps."))
      )
    );
  });

  it.each<[string, JsonValue, string]>([
    [
      "a stale block hash",
      {
        find: "Done",
        hash: hash(0),
        index: 3,
        replace: "x",
        type: "replaceText",
      },
      "Block 3 does not match its hash",
    ],
    [
      "a missing block",
      {
        find: "Done",
        hash: hash(3),
        index: 9,
        replace: "x",
        type: "replaceText",
      },
      "Block 9 does not exist",
    ],
    [
      "repeated find text",
      { find: "e", hash: hash(1), index: 1, replace: "x", type: "replaceText" },
      "find text appears 3 times",
    ],
    [
      "find text across formatting",
      {
        find: "with drip",
        hash: hash(0),
        index: 0,
        replace: "x",
        type: "replaceText",
      },
      "crosses a formatting or link boundary",
    ],
    [
      "absent find text",
      {
        find: "Missing",
        hash: hash(3),
        index: 3,
        replace: "x",
        type: "replaceText",
      },
      "find text was not found",
    ],
    [
      "a stale replaceBlocks hash",
      { hashes: [hash(1)], index: 0, nodes: [], type: "replaceBlocks" },
      "Block 0 does not match its hash",
    ],
    [
      "a stale non-first replaceBlocks hash",
      {
        hashes: [hash(0), hash(0)],
        index: 0,
        nodes: [],
        type: "replaceBlocks",
      },
      "Block 1 does not match its hash",
    ],
    [
      "a stale insertBlocks afterHash",
      {
        afterHash: hash(0),
        afterIndex: 3,
        nodes: [heading("x")],
        type: "insertBlocks",
      },
      "Block 3 does not match its hash",
    ],
  ])("rejects %s before writes", async (_, edit, message) => {
    const fake = cma();
    await expect(
      updateContentfulFields(patch({ edits: [edit], embeds: null }))
    ).rejects.toThrow(message);
    expect(fake.writes()).toHaveLength(0);
  });

  it.each<[string, JsonValue[], string]>([
    [
      "text and block edits on one block",
      [
        {
          find: "Done",
          hash: hash(3),
          index: 3,
          replace: "x",
          type: "replaceText",
        },
        { hashes: [hash(3)], index: 3, nodes: [], type: "replaceBlocks" },
      ],
      "More than one replacement targets block 3",
    ],
    [
      "an insertion inside a replaced range",
      [
        {
          hashes: [hash(0), hash(1)],
          index: 0,
          nodes: [],
          type: "replaceBlocks",
        },
        {
          afterHash: hash(0),
          afterIndex: 0,
          nodes: [heading("x")],
          type: "insertBlocks",
        },
      ],
      "An insertion falls inside the replaced blocks 0 to 1",
    ],
    [
      "two insertions at one position",
      [
        {
          afterHash: null,
          afterIndex: null,
          nodes: [heading("a")],
          type: "insertBlocks",
        },
        {
          afterHash: null,
          afterIndex: null,
          nodes: [heading("b")],
          type: "insertBlocks",
        },
      ],
      "More than one insertion targets position 0",
    ],
  ])("rejects %s", async (_, edits, message) => {
    const fake = cma();
    await expect(
      updateContentfulFields(patch({ edits, embeds: null }))
    ).rejects.toThrow(message);
    expect(fake.writes()).toHaveLength(0);
  });

  it("requires a matching embeds list to add, remove, or move embeds", async () => {
    const remove = {
      hashes: [hash(2)],
      index: 2,
      nodes: [],
      type: "replaceBlocks",
    };
    const fake = cma();
    await expect(
      updateContentfulFields(patch({ edits: [remove], embeds: null }))
    ).rejects.toThrow(
      "This patch adds, removes, or reorders embeds (before: [codeSample], after: [])"
    );
    await expect(
      updateContentfulFields(patch({ edits: [remove], embeds: ["codeSample"] }))
    ).rejects.toThrow("do not match the embeds list");
    expect(fake.writes()).toHaveLength(0);
    await updateContentfulFields(patch({ edits: [remove], embeds: [] }));
    expect(savedMain(fake)["en-US"]).toEqual(
      doc(intro, setup, paragraph(text("Done.")))
    );
  });

  it("validates the references a patch introduces", async () => {
    const insert = (id: string) => ({
      afterHash: hash(3),
      afterIndex: 3,
      nodes: [embed(id)],
      type: "insertBlocks",
    });
    const fake = cma();
    await expect(
      updateContentfulFields(
        patch({ edits: [insert("missing")], embeds: ["codeSample", "missing"] })
      )
    ).rejects.toThrow("main: referenced Entry missing was not found.");
    expect(fake.writes()).toHaveLength(0);
    await updateContentfulFields(
      patch({
        edits: [insert("otherSample")],
        embeds: ["codeSample", "otherSample"],
      })
    );
    expect(savedMain(fake)["en-US"]).toEqual(
      doc(...blocks, embed("otherSample"))
    );
  });

  it("validates the patched document against the model", async () => {
    const fake = cma();
    await expect(
      updateContentfulFields(
        patch({
          edits: [
            {
              hashes: blocks.map((_, index) => hash(index)),
              index: 0,
              nodes: [],
              type: "replaceBlocks",
            },
          ],
          embeds: [],
        })
      )
    ).rejects.toThrow("Required RichText field cannot be empty.");
    await expect(
      updateContentfulFields(
        patch({
          edits: [
            {
              afterHash: null,
              afterIndex: null,
              nodes: [text("loose")],
              type: "insertBlocks",
            },
          ],
          embeds: null,
        })
      )
    ).rejects.toThrow("Invalid value for main: Invalid RichText document");
    expect(fake.writes()).toHaveLength(0);
  });

  it("patches bodies larger than the whole-value node limit", async () => {
    const long = doc(
      ...Array.from({ length: 600 }, (_, index) =>
        paragraph(text(`Paragraph ${index}.`))
      )
    );
    const fake = cma(guide(long));
    await updateContentfulFields(
      patch({
        edits: [
          {
            find: "599",
            hash: richTextBlockHash(long.content[599]),
            index: 599,
            replace: "six hundred",
            type: "replaceText",
          },
        ],
        embeds: null,
      })
    );
    // SAFETY: This fixture patches the long document while preserving its document/content structure.
    const saved = savedMain(fake)["en-US"] as typeof long;
    expect(saved.content[599]).toEqual(
      paragraph(text("Paragraph six hundred."))
    );
    expect(saved.content.slice(0, 599)).toEqual(long.content.slice(0, 599));
  });

  it("starts an empty body from a patch", async () => {
    const fake = cma(guide(null));
    await updateContentfulFields(
      patch({
        edits: [
          {
            afterHash: null,
            afterIndex: null,
            nodes: [paragraph(text("First words."))],
            type: "insertBlocks",
          },
        ],
        embeds: null,
      })
    );
    expect(savedMain(fake)).toEqual({
      "en-US": doc(paragraph(text("First words."))),
    });
  });

  it("rejects patches on other field types and malformed patches", async () => {
    cma();
    await expect(
      updateContentfulFields(
        patch(
          {
            edits: [
              {
                find: "G",
                hash: hash(0),
                index: 0,
                replace: "x",
                type: "replaceText",
              },
            ],
            embeds: null,
          },
          "title"
        )
      )
    ).rejects.toThrow("Field title: patch only applies to RichText fields.");
    await expect(
      updateContentfulFields(patch({ edits: [], embeds: null }))
    ).rejects.toThrow("Invalid RichText patch");
  });

  it("uses the block indexes and hashes returned by read_contentful_content", async () => {
    const fake = cma();
    const read = await readEntryContent(
      `https://app.contentful.com/spaces/${QUERY_SPACES.docs}/environments/master/entries/guide`,
      null,
      undefined,
      { richTextJson: true }
    );
    const done = read.sections.find(({ text: value }) => value === "Done.");
    expect(done?.block).toEqual({
      hash: hash(3),
      index: 3,
      json: blocks[3],
      nodeType: "paragraph",
    });
    if (!done?.block) {
      throw new Error("The read did not return block 3.");
    }
    await updateContentfulFields(
      patch({
        edits: [
          {
            find: "Done",
            hash: done.block.hash,
            index: done.block.index,
            replace: "Finished",
            type: "replaceText",
          },
        ],
        embeds: null,
      })
    );
    expect(savedMain(fake)["en-US"]).toEqual(
      doc(intro, setup, embed("codeSample"), paragraph(text("Finished.")))
    );
  });
});

/* A page or component whose RichText body holds the shared patch fixture. */
const bodyCma = ({
  contentTypeId,
  fieldId,
}: {
  contentTypeId: string;
  fieldId: string;
}) =>
  createCmaFake({
    contentTypes: (id) =>
      contentType(id, [
        { id: "title", name: "Title", type: "Symbol" },
        { id: fieldId, name: "Body", type: "RichText" },
      ]),
    entries: [
      {
        fields: {
          [fieldId]: { "en-US": body },
          slug: { "en-US": "page" },
          title: { "en-US": "Page" },
        },
        sys: {
          contentType: link(contentTypeId, "ContentType"),
          id: "page",
          publishedVersion: 6,
          version: 7,
        },
      },
      {
        fields: {},
        sys: {
          contentType: link("codeBlock", "ContentType"),
          id: "codeSample",
          publishedVersion: 1,
          version: 2,
        },
      },
    ],
  });

describe("RichText body patches and publication", () => {
  const replaceDone = {
    edits: [
      {
        find: "Done",
        hash: hash(3),
        index: 3,
        replace: "Finished",
        type: "replaceText",
      },
    ],
    embeds: null,
  };

  it.each([
    { ...PROTECTED_PAGE_BODY, requiresApproval: true },
    { ...COMPONENT_BODY, requiresApproval: false },
  ])(
    "patches a RichText body and requires approval only for pages: %j",
    async ({ requiresApproval, ...richTextBody }) => {
      const { fieldId, space } = richTextBody;
      const fake = bodyCma(richTextBody);
      expect(
        await updateContentfulFields({
          entries: [
            {
              changes: [{ fieldId, operation: "patch", value: replaceDone }],
              entryId: "page",
              expectedVersion: 7,
            },
          ],
          space,
        })
      ).toMatchObject({
        complete: true,
        results: [{ outcome: "updated", version: 8 }],
      });
      expect(fake.writes().map(({ method }) => method)).toEqual(["PUT"]);
      expect(fake.entries.get("page")?.fields[fieldId]).toEqual({
        "en-US": doc(
          intro,
          setup,
          embed("codeSample"),
          paragraph(text("Finished."))
        ),
      });
      const plan = await prepareContentfulPublication({
        entries: [{ entryId: "page", expectedVersion: 8 }],
        space,
      });
      expect(plan.requiresApproval).toBe(requiresApproval);
      expect(plan.items.map(({ entryId }) => entryId)).toEqual(["page"]);
    }
  );
});
