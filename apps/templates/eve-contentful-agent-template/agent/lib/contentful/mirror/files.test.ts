import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { RawContentType, RawEntry } from "../types";
import { mirrorBuildSql } from "./database";
import {
  mirrorDataPath,
  mirrorFilePath,
  parseMirrorManifest,
  renderMirrorData,
  renderMirrorFile,
  renderSchemaLines,
} from "./files";

const guide = {
  fields: {
    body: {
      "en-US": {
        content: [
          {
            content: [{ nodeType: "text", value: "Ferns prefer loose soil." }],
            nodeType: "paragraph",
          },
        ],
        nodeType: "document",
      },
    },
    date: { "en-US": "2026-09-01" },
    relatedGuide: {
      "en-US": { sys: { id: "other", linkType: "Entry", type: "Link" } },
    },
    slug: { "en-US": "repot-a-fern" },
    tags: { "en-US": ["ferns", "soil"] },
    title: { "en-US": 'The "Repotting" guide' },
  },
  sys: {
    id: "guide1",
    publishedAt: "2026-09-01T00:00:00.000Z",
    publishedVersion: 4,
    updatedAt: "2026-09-02T00:00:00.000Z",
    version: 7,
  },
} satisfies RawEntry;

describe("Contentful mirror data sidecar", () => {
  it("maps Markdown paths to sibling JSON paths", () => {
    expect(mirrorDataPath("/contentful/sample-docs/guide1.md")).toBe(
      "/contentful/sample-docs/guide1.json"
    );
  });

  it("renders metadata, actors, scalar fields, and every link as one JSON line", () => {
    const text = renderMirrorData(
      {
        ...guide,
        fields: {
          ...guide.fields,
          body: {
            "en-US": {
              content: [
                {
                  content: [],
                  data: {
                    target: {
                      sys: { id: "code1", linkType: "Entry", type: "Link" },
                    },
                  },
                  nodeType: "embedded-entry-block",
                },
              ],
              nodeType: "document",
            },
          },
          featured: { "en-US": true },
        },
        sys: {
          ...guide.sys,
          contentType: {
            sys: { id: "guide", linkType: "ContentType", type: "Link" },
          },
          createdAt: "2026-08-01T00:00:00.000Z",
          firstPublishedAt: "2026-08-15T00:00:00.000Z",
          updatedBy: { sys: { id: "user9", linkType: "User", type: "Link" } },
        },
      },
      "sample-docs"
    );

    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim()).not.toContain("\n");
    const data = JSON.parse(text);
    expect(data).toMatchObject({
      contentType: "guide",
      createdAt: "2026-08-01T00:00:00.000Z",
      createdBy: null,
      entryId: "guide1",
      fields: {
        date: "2026-09-01",
        featured: true,
        slug: "repot-a-fern",
        tags: ["ferns", "soil"],
      },
      firstPublishedAt: "2026-08-15T00:00:00.000Z",
      space: "sample-docs",
      status: "changed",
      updatedBy: "user9",
      version: 7,
    });
    // Rich text and links stay out of fields; links are listed as references.
    expect(data.fields).not.toHaveProperty("body");
    expect(data.fields).not.toHaveProperty("relatedGuide");
    expect(data.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "/body",
          id: "code1",
          relationship: "embed",
        }),
        expect.objectContaining({
          field: "/relatedGuide",
          id: "other",
          relationship: "reference",
        }),
      ])
    );
  });
});

describe("Contentful mirror files", () => {
  it("renders metadata and text fields, without linked entries or repeated metadata", () => {
    expect(
      renderMirrorFile(
        {
          ...guide,
          sys: {
            ...guide.sys,
            contentType: {
              sys: { id: "guide", linkType: "ContentType", type: "Link" },
            },
          },
        },
        "sample-docs"
      )
    ).toBe(
      [
        "---",
        'entryId: "guide1"',
        'space: "sample-docs"',
        'kind: "guide"',
        'status: "changed"',
        'title: "The \\"Repotting\\" guide"',
        'slug: "repot-a-fern"',
        'url: "https://example.com/help/guide/repot-a-fern"',
        'contentfulUrl: "https://app.contentful.com/spaces/sample-docs/environments/master/entries/guide1"',
        'date: "2026-09-01"',
        "version: 7",
        'updatedAt: "2026-09-02T00:00:00.000Z"',
        'publishedAt: "2026-09-01T00:00:00.000Z"',
        "---",
        "",
        "## /body",
        "",
        "Ferns prefer loose soil.",
        "",
        "## /tags",
        "",
        "ferns, soil",
        "",
      ].join("\n")
    );
  });

  it("places files by space ID and entry ID, rejecting unsafe IDs", () => {
    expect(mirrorFilePath("sample-site", "abc_123-X")).toBe(
      "/contentful/sample-site/abc_123-X.md"
    );
    expect(mirrorFilePath("sample-site", "../manifest")).toBeNull();
    expect(mirrorFilePath("../sample-site", "abc_123-X")).toBeNull();
  });

  it("accepts only complete version 1 manifests", () => {
    const manifest = {
      entryCount: 2,
      fullSyncedAt: "2026-10-08T00:00:00.000Z",
      syncedAt: "2026-10-08T01:00:00.000Z",
      version: 1,
    };
    expect(parseMirrorManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(
      parseMirrorManifest(JSON.stringify({ ...manifest, configuration: 42 }))
    ).toBeNull();
    expect(
      parseMirrorManifest(JSON.stringify({ ...manifest, entryCount: -1 }))
    ).toBeNull();
    expect(parseMirrorManifest(null)).toBeNull();
    expect(parseMirrorManifest("{")).toBeNull();
    expect(
      parseMirrorManifest(JSON.stringify({ ...manifest, syncedAt: "soon" }))
    ).toBeNull();
    expect(
      parseMirrorManifest(JSON.stringify({ ...manifest, version: 2 }))
    ).toBeNull();
  });
});

/* Build a page entry whose body has one paragraph per string. */
const pageEntry = (
  id: string,
  title: string,
  paragraphs: string[],
  fields: RawEntry["fields"] = {},
  sys: Partial<RawEntry["sys"]> = {}
): RawEntry => ({
  fields: {
    ...fields,
    body: {
      "en-US": {
        content: paragraphs.map((value) => ({
          content: [{ nodeType: "text", value }],
          nodeType: "paragraph",
        })),
        nodeType: "document",
      },
    },
    slug: { "en-US": title.toLowerCase().replaceAll(" ", "-") },
    title: { "en-US": title },
  },
  sys: { id, updatedAt: "2026-09-02T00:00:00.000Z", version: 1, ...sys },
});

const listingEntries = [
  pageEntry(
    "about",
    "How to grow a rose in shade",
    [
      "Gardeners who plant a rose in deep shade rarely see blooms unless they choose carefully.",
      "## Prune each rose",
      "Every rose variety lists its sunlight needs on the label.",
    ],
    { tags: { "en-US": ["rose", "shade"] } }
  ),
  pageEntry(
    "passing",
    "Slow release vs liquid fertilizer",
    [
      "A long comparison of two fertilizer styles, covering compost teas and granules.",
      "Every rosemary bed is fed monthly.",
      "Gardeners who use slow release feed, such as rose growers, water less often.",
    ],
    {},
    { publishedVersion: 1, updatedAt: "2026-09-03T00:00:00.000Z", version: 2 }
  ),
  pageEntry(
    "tagOnly",
    "Shade gardening",
    ["Planting calendar."],
    { tags: { "en-US": ["rose"] } },
    { updatedAt: "2026-09-01T00:00:00.000Z" }
  ),
  pageEntry("titleOnly", "Rose planting calendar", ["Planting calendar."]),
  pageEntry("unrelated", "Lawn care", ["Every rosebud matters."]),
];

const synced = "content as of 2026-10-09T03:00:10.000Z";

/* The search_content skill's script; it needs a DuckDB binary on PATH or in DUCKDB_BIN. */
const SQL_SCRIPT = fileURLToPath(
  new URL("../../../skills/search_content/scripts/sql", import.meta.url)
);
const hasDuckdb =
  Boolean(process.env.DUCKDB_BIN) ||
  spawnSync("sh", ["-c", "command -v duckdb"]).status === 0;

/* Render entries as Markdown plus JSON sidecars in sample-docs, then run one query. */
/*
 * Compacted database variants: none, built and listed in the manifest, built but not
 * listed (left over from an earlier sync), listed but not a valid database, or listed
 * but built before the search macro or the users table existed. Built copies carry a
 * `marker` table.
 */
type DatabaseMode =
  | "none"
  | "listed"
  | "unlisted"
  | "corrupt"
  | "nosearch"
  | "nousers";

/* Statements that make a freshly built database look like one from an older sync. */
const OLDER_DATABASE: Partial<Record<DatabaseMode, string>> = {
  nosearch: "DROP MACRO TABLE m.search;",
  nousers: "DROP TABLE m.users;",
};

/* Build the database with the sync's own SQL, reading the local copy. */
const buildTestDatabase = (mirror: string, mode: DatabaseMode = "listed") => {
  const target = `${mirror}/mirror.duckdb`;
  const result = spawnSync(
    process.env.DUCKDB_BIN || "duckdb",
    [
      "-c",
      `${mirrorBuildSql(target, mirror)}
ATTACH '${target}' AS m;
CREATE TABLE m.marker AS SELECT 'database' AS source;
${OLDER_DATABASE[mode] ?? ""}`,
    ],
    { encoding: "utf-8" }
  );
  expect(result.status, result.stderr).toBe(0);
};

/* Content type stored with the test copy, as a sync would write it. */
const guideSchema: RawContentType = {
  description: "Help article",
  displayField: "title",
  fields: [
    { id: "title", name: "Title", required: true, type: "Symbol" },
    { id: "body", name: "Body", type: "RichText" },
    {
      id: "related",
      items: {
        linkType: "Entry",
        type: "Link",
        validations: [{ linkContentType: ["guide"] }],
      },
      name: "Related",
      type: "Array",
    },
  ],
  name: "Guide",
  sys: { id: "guide" },
};

/* Optional changes to the test copy, and the environment the script runs with. */
interface MirrorOptions {
  database?: DatabaseMode;
  env?: NodeJS.ProcessEnv;
  /* Entries whose Markdown file is written with CRLF line endings. */
  crlf?: string[];
  /* Entries written to the sample-site space as well. */
  siteEntries?: RawEntry[];
  /*
   * Contents of users.ndjson, empty by default; null leaves the file out, like a copy
   * synced before users were stored. The database build needs the file.
   */
  users?: string | null;
  withSchema?: boolean;
}

/* Render entries as Markdown plus JSON sidecars, then run each query in turn against one copy. */
const queryMirror = (
  entries: RawEntry[],
  queries: string[],
  options: MirrorOptions = {}
) => {
  const {
    crlf = [],
    database = "none",
    siteEntries = [],
    users = "",
  } = options;
  const mirror = mkdtempSync(path.join(tmpdir(), "query-mirror-"));
  try {
    if (options.withSchema ?? true) {
      writeFileSync(
        path.join(mirror, "content-types.ndjson"),
        renderSchemaLines("sample-docs", [guideSchema])
      );
    }
    if (users !== null) {
      writeFileSync(path.join(mirror, "users.ndjson"), users);
    }
    const spaces = [
      ["sample-docs", entries],
      ["sample-site", siteEntries],
    ] as const;
    for (const [space, list] of spaces) {
      mkdirSync(path.join(mirror, space));
      for (const entry of list) {
        const file = path.join(mirror, space, `${entry.sys.id}.md`);
        const markdown = renderMirrorFile(entry, space);
        writeFileSync(
          file,
          crlf.includes(entry.sys.id)
            ? markdown.replaceAll("\n", "\r\n")
            : markdown
        );
        writeFileSync(mirrorDataPath(file), renderMirrorData(entry, space));
      }
    }
    if (database === "corrupt") {
      writeFileSync(path.join(mirror, "mirror.duckdb"), "not a database\n");
    } else if (database !== "none") {
      buildTestDatabase(mirror, database);
    }
    writeFileSync(
      path.join(mirror, "manifest.json"),
      JSON.stringify({
        ...(database !== "none" &&
          database !== "unlisted" && {
            database: "mirror.duckdb",
          }),
        syncedAt: "2026-10-09T03:00:10.000Z",
      })
    );
    mkdirSync(path.join(mirror, ".tmp"));
    return queries.map((sql) =>
      spawnSync("sh", [SQL_SCRIPT, sql], {
        encoding: "utf-8",
        env: {
          ...process.env,
          ...options.env,
          CONTENTFUL_DIR: mirror,
          TMPDIR: path.join(mirror, ".tmp"),
        },
      })
    );
  } finally {
    rmSync(mirror, { force: true, recursive: true });
  }
};

/* Run one query against a fresh copy of the entries. */
const querySql = (
  entries: RawEntry[],
  sql: string,
  database: DatabaseMode = "none",
  withSchema = true
) => {
  const [result] = queryMirror(entries, [sql], { database, withSchema });
  if (!result) {
    throw new Error("No query result.");
  }
  return result;
};

const typed = (entry: RawEntry, contentType: string): RawEntry => ({
  ...entry,
  sys: {
    ...entry.sys,
    contentType: {
      sys: { id: contentType, linkType: "ContentType", type: "Link" },
    },
  },
});

/* A guide with ID "twin", written to either space. */
const twin = (title: string, text: string): RawEntry =>
  typed(pageEntry("twin", title, [text]), "guide");

/* One users.ndjson line, as the sync writes it. */
const user = (space: string, userId: string, name: string | null) =>
  `${JSON.stringify({ name, space, userId })}\n`;

/* A guide last updated by the given user. */
const editedBy = (id: string, title: string, userId: string): RawEntry =>
  typed(
    pageEntry(
      id,
      title,
      ["Text."],
      {},
      {
        updatedBy: { sys: { id: userId, linkType: "User", type: "Link" } },
      }
    ),
    "guide"
  );

describe.skipIf(!hasDuckdb)("search_content sql script", () => {
  const codeBlock = typed(
    {
      fields: { language: { "en-US": "ts" } },
      sys: { id: "code1", version: 1 },
    },
    "codeBlock"
  );
  const withEmbed = typed(
    {
      fields: {
        body: {
          "en-US": {
            content: [
              {
                content: [],
                data: {
                  target: {
                    sys: { id: "code1", linkType: "Entry", type: "Link" },
                  },
                },
                nodeType: "embedded-entry-block",
              },
            ],
            nodeType: "document",
          },
        },
        slug: { "en-US": "with-embed" },
        title: { "en-US": "Uses a code block" },
      },
      sys: { id: "page1", publishedVersion: 1, version: 2 },
    },
    "guide"
  );
  const entries = [
    codeBlock,
    withEmbed,
    ...listingEntries.map((entry) => typed(entry, "guide")),
  ];

  it("counts entries by type and reports the sync time", () => {
    const result = querySql(
      entries,
      "SELECT contentType, count(*) AS n FROM entries GROUP BY ALL ORDER BY ALL"
    );
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "contentType,n",
      "codeBlock,1",
      "guide,6",
    ]);
    expect(lines.slice(3)).toEqual([`# 2 rows; ${synced}`, ""]);
  });

  it("counts and cuts rows by CSV record when values span lines", () => {
    const two = querySql(
      entries,
      "SELECT 'a' || chr(10) || 'b' AS x FROM range(2)"
    );
    expect(two.stdout).toBe(
      ["x", '"a', 'b"', '"a', 'b"', `# 2 rows; ${synced}`, ""].join("\n")
    );
    const many = querySql(
      entries,
      "SELECT 'a' || chr(10) || 'b' AS x FROM range(201)"
    );
    expect(many.stdout).toBe(
      [
        "x",
        ...Array.from({ length: 200 }, () => '"a\nb"'),
        `# Showing 200 of 201 rows; add LIMIT/OFFSET or aggregate. Content as of 2026-10-09T03:00:10.000Z`,
        "",
      ].join("\n")
    );
  });

  it("resolves embedded components through the refs view", () => {
    const result = querySql(
      entries,
      "SELECT fromId, toType, relationship FROM refs WHERE toType = 'codeBlock'"
    );
    expect(result.stdout.split("\n").slice(0, 2)).toEqual([
      "fromId,toType,relationship",
      "page1,codeBlock,embed",
    ]);
  });

  it("names each link's target so entries can be found by who they link to", () => {
    const linked = typed(
      {
        fields: {
          related: {
            "en-US": [
              { sys: { id: "page1", linkType: "Entry", type: "Link" } },
            ],
          },
          title: { "en-US": "Links to the embed page" },
        },
        sys: { id: "linker", version: 1 },
      },
      "guide"
    );
    const sql =
      "SELECT fromId, toTitle FROM refs WHERE toTitle ILIKE '%code block%'";
    for (const mode of ["none", "listed"] as const) {
      const result = querySql([...entries, linked], sql, mode);
      expect(result.stdout.split("\n").slice(0, 2), result.stderr).toEqual([
        "fromId,toTitle",
        "linker,Uses a code block",
      ]);
    }
  });

  it("matches text in the pages view with regular expressions", () => {
    const result = querySql(
      entries,
      "SELECT count(*) AS n FROM pages WHERE regexp_matches(lower(content), '(^|[^a-z0-9_])(rose)([^a-z0-9_]|$)')"
    );
    expect(result.stdout.split("\n")[1]).toBe("4");
  });

  /* Both the compacted database and the views over the files define search(). */
  const searchModes = ["none", "listed"] as const;
  const longLine = `${"Soil preparation matters for every bed. ".repeat(8)}Prune the rose after flowering, then mulch. ${"Water deeply once a week. ".repeat(4)}`;
  const searchEntries = [
    ...entries,
    typed(pageEntry("repeats", "Repeats", ["Rose rose, ROSE."]), "blogPost"),
    typed(
      pageEntry("symbols", "Symbols", [
        "Learn C++ quickly.",
        "Config a.b applies.",
        "Config axb differs.",
      ]),
      "guide"
    ),
    typed(pageEntry("long", "Long", [longLine]), "guide"),
    typed(
      {
        ...pageEntry("slugOnly", "Mulch basics", ["Spread it thin."]),
        fields: {
          ...pageEntry("slugOnly", "Mulch basics", ["Spread it thin."]).fields,
          slug: { "en-US": "hidden-word" },
        },
      },
      "guide"
    ),
    typed(pageEntry("accents", "Accents", ["Visit the café today."]), "guide"),
    typed(
      pageEntry("backslash", "Backslash", ["Use a\\b here, not ab."]),
      "guide"
    ),
    typed(
      pageEntry("rule", "Rule", [
        "Before the rule.",
        "---",
        "After the rule, a zinnia.",
      ]),
      "guide"
    ),
  ];

  it("finds whole words in each page's title and text, ignoring case, and counts mentions in both", () => {
    const sql =
      "SELECT entryId, contentType, mentions FROM search('ROSE') ORDER BY mentions DESC, entryId";
    for (const mode of searchModes) {
      const result = querySql(searchEntries, sql, mode);
      expect(result.stdout.split("\n").slice(0, 8), result.stderr).toEqual([
        "entryId,contentType,mentions",
        "about,guide,5",
        "repeats,blogPost,3",
        "long,guide,1",
        "passing,guide,1",
        "tagOnly,guide,1",
        "titleOnly,guide,1",
        `# 6 rows; ${synced}`,
      ]);
      // The database answers itself rather than falling back to the files.
      expect(result.stderr).toBe("");
    }
  });

  it("filters search results by entry columns in the same query", () => {
    const sql =
      "SELECT entryId, status, title FROM search('rose') WHERE contentType = 'guide' AND status = 'published'";
    for (const mode of searchModes) {
      const result = querySql(searchEntries, sql, mode);
      expect(result.stdout.split("\n").slice(0, 3), result.stderr).toEqual([
        "entryId,status,title",
        "passing,published,Slow release vs liquid fertilizer",
        `# 1 rows; ${synced}`,
      ]);
    }
  });

  it("matches the title without passages, but not the slug, URL, or other metadata", () => {
    for (const mode of searchModes) {
      const title = querySql(
        searchEntries,
        "SELECT entryId, mentions, len(passages) AS n FROM search('lawn care')",
        mode
      );
      expect(title.stdout.split("\n").slice(0, 3), title.stderr).toEqual([
        "entryId,mentions,n",
        "unrelated,1,0",
        `# 1 rows; ${synced}`,
      ]);
      for (const term of ["hidden", "slug", "draft", "slugonly"]) {
        const result = querySql(
          searchEntries,
          `SELECT entryId FROM search('${term}')`,
          mode
        );
        expect(result.stdout.split("\n").slice(0, 2), term).toEqual([
          "entryId",
          `# 0 rows; ${synced}`,
        ]);
      }
    }
  });

  it("matches alternatives separated by | and treats other regex characters literally", () => {
    const cases: [string, string[]][] = [
      ["c++|a.b", ["symbols,2"]],
      [" c++ |  a.b | ", ["symbols,2"]],
      [" lawn care", ["unrelated,1"]],
      ["caf", []],
      ["CAFÉ", ["accents,1"]],
      ["a\\b", ["backslash,1"]],
      ["slow release|comp.st|", ["passing,2"]],
      ["c+", ["symbols,1"]],
      ["(rose)", []],
      ["|", []],
      ["", []],
    ];
    for (const mode of searchModes) {
      for (const [term, rows] of cases) {
        const result = querySql(
          searchEntries,
          `SELECT entryId, mentions FROM search('${term}') ORDER BY ALL`,
          mode
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.split("\n").slice(1, -2), term).toEqual(rows);
      }
    }
  });

  it("returns every entry column, the opening text, and up to three passages", () => {
    for (const mode of searchModes) {
      const all = querySql(
        searchEntries,
        "SELECT * FROM search('rose') WHERE entryId = 'about'",
        mode
      );
      expect(all.stdout.split("\n")[0], all.stderr).toBe(
        "space,entryId,contentType,status,title,url,contentfulUrl,updatedAt,mentions,opening,passages"
      );
      const about = querySql(
        searchEntries,
        "SELECT opening, len(passages) AS n, passages[1] AS first, passages[3] AS third FROM search('rose') WHERE entryId = 'about'",
        mode
      );
      expect(about.stdout.split("\n").slice(0, 2), about.stderr).toEqual([
        "opening,n,first,third",
        '"rose, shade Gardeners who plant a rose in deep shade rarely see blooms unless they choose carefully. ## Prune each rose Every rose variety lists its sunlight needs on the label.",3,"rose, shade",## Prune each rose',
      ]);
      const long = querySql(
        searchEntries,
        "SELECT length(opening) AS o, starts_with(passages[1], '…') AS cut, length(passages[1]) AS p, passages[1] LIKE '%Prune the rose after flowering%' AS hit FROM search('rose') WHERE entryId = 'long'",
        mode
      );
      expect(long.stdout.split("\n").slice(0, 2), long.stderr).toEqual([
        "o,cut,p,hit",
        "201,true,202,true",
      ]);
    }
  });

  it("strips the metadata block from CRLF files and pages with a --- line", () => {
    const crlf = typed(
      pageEntry("crlf", "Windows", ["Zebra line one.", "Second zebra line."]),
      "guide"
    );
    for (const database of searchModes) {
      const [result] = queryMirror(
        [...searchEntries, crlf],
        [
          "SELECT entryId, mentions, opening, passages FROM search('zebra|zinnia|entryid|rule') WHERE entryId IN ('crlf', 'rule') ORDER BY entryId",
        ],
        { crlf: ["crlf"], database }
      );
      expect(result?.stdout.split("\n").slice(0, 3), result?.stderr).toEqual([
        "entryId,mentions,opening,passages",
        'crlf,2,Zebra line one. Second zebra line.,"[Zebra line one., Second zebra line.]"',
        // The title and both text lines mention "rule"; the --- line stays in the text.
        `rule,4,"Before the rule. --- After the rule, a zinnia.","[Before the rule., 'After the rule, a zinnia.']"`,
      ]);
    }
  });

  it("keeps entries with the same ID in different spaces apart", () => {
    for (const database of searchModes) {
      const [result] = queryMirror(
        [twin("Docs twin", "One marigold.")],
        [
          "SELECT space, entryId, title, mentions FROM search('marigold') ORDER BY space",
        ],
        { database, siteEntries: [twin("Site twin", "Marigold, marigold.")] }
      );
      expect(result?.stdout.split("\n").slice(0, 4), result?.stderr).toEqual([
        "space,entryId,title,mentions",
        "sample-docs,twin,Docs twin,1",
        "sample-site,twin,Site twin,2",
        `# 2 rows; ${synced}`,
      ]);
    }
  });

  it("runs the topic search example from the search_content skill as written", () => {
    const skill = readFileSync(
      fileURLToPath(
        new URL("../../../skills/search_content/SKILL.md", import.meta.url)
      ),
      "utf-8"
    );
    const example =
      /## Find pages about a topic or wording\n[\s\S]*?```sql\n(?<sql>[\s\S]*?)```/u.exec(
        skill
      )?.groups?.sql;
    expect(example).toBeDefined();
    for (const database of searchModes) {
      const result = querySql(searchEntries, example ?? "", database);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^\S+,/u);
    }
  });

  it("remembers a failed database check instead of repeating it", () => {
    const real =
      process.env.DUCKDB_BIN ||
      spawnSync("sh", ["-c", "command -v duckdb"], {
        encoding: "utf-8",
      }).stdout.trim();
    const bin = mkdtempSync(path.join(tmpdir(), "query-mirror-bin-"));
    try {
      // A DuckDB that records each database check before running the real one.
      const log = path.join(bin, "checks.log");
      const wrapper = path.join(bin, "duckdb");
      writeFileSync(
        wrapper,
        `#!/bin/sh\ncase "$*" in *"search('')"*) echo check >> "${log}" ;; esac\nexec "${real}" "$@"\n`,
        { mode: 0o755 }
      );
      const results = queryMirror(
        searchEntries,
        ["SELECT count(*) AS n FROM search('rose')", "SELECT 1 AS n"],
        { database: "nosearch", env: { DUCKDB_BIN: wrapper } }
      );
      for (const result of results) {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Queries are slower than usual");
      }
      expect(results.map((result) => result.stdout.split("\n")[1])).toEqual([
        "6",
        "1",
      ]);
      expect(readFileSync(log, "utf-8")).toBe("check\n");
    } finally {
      rmSync(bin, { force: true, recursive: true });
    }
  });

  it("answers search() from the files when the database predates the macro", () => {
    const result = querySql(
      searchEntries,
      "SELECT count(*) AS n FROM search('rose')",
      "nosearch"
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Queries are slower than usual");
    expect(result.stdout.split("\n")[1]).toBe("6");
  });

  // Write protection comes from the read-only mount and the sandbox; the script only locks settings.
  it("locks DuckDB settings after defining the views", () => {
    const result = querySql(entries, "SET enable_external_access = true");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("configuration has been locked");
  });

  it("answers from the compacted database when the manifest lists it", () => {
    const result = querySql(entries, "SELECT source FROM marker", "listed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n").slice(0, 2)).toEqual([
      "source",
      "database",
    ]);
  });

  it("gives the same answers from the database as from the files", () => {
    const sql =
      "SELECT fromId, toType, relationship FROM refs WHERE toType = 'codeBlock'";
    expect(querySql(entries, sql, "listed").stdout).toBe(
      querySql(entries, sql, "none").stdout
    );
  });

  it("leaves an asset link's target unresolved even when an entry has its ID", () => {
    const withAsset = typed(
      {
        fields: {
          image: {
            "en-US": { sys: { id: "code1", linkType: "Asset", type: "Link" } },
          },
          title: { "en-US": "Links an asset" },
        },
        sys: { id: "assetLinker", version: 1 },
      },
      "guide"
    );
    const sql =
      "SELECT linkType, toId, toType, toTitle FROM refs WHERE fromId = 'assetLinker'";
    for (const mode of ["none", "listed"] as const) {
      const result = querySql([...entries, withAsset], sql, mode);
      expect(result.stdout.split("\n").slice(0, 2), result.stderr).toEqual([
        "linkType,toId,toType,toTitle",
        "Asset,code1,NULL,NULL",
      ]);
    }
  });

  it("answers from the files when the listed database can't be opened", () => {
    const result = querySql(
      entries,
      "SELECT count(*) AS n FROM entries",
      "corrupt"
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n").slice(0, 2)).toEqual(["n", "7"]);
    expect(result.stderr).toContain(
      "Queries are slower than usual in this session."
    );
  });

  it("ignores a database the manifest does not list", () => {
    const result = querySql(entries, "SELECT source FROM marker", "unlisted");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("marker");
  });

  it("reports SQL errors from the database without falling back", () => {
    const result = querySql(entries, "SELECT nope FROM entries", "listed");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Binder Error");
    expect(result.stderr).not.toContain("Queries are slower than usual");
  });

  it("reports runtime errors from the database without falling back", () => {
    const result = querySql(
      entries,
      "SELECT regexp_matches('a', '(') AS m",
      "listed"
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid Input Error");
    expect(result.stderr).not.toContain("Queries are slower than usual");
  });

  it("runs statements without output once, against the database", () => {
    const result = querySql(
      entries,
      "CREATE TEMP TABLE t AS SELECT 1 AS n",
      "listed"
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`\n# 0 rows; ${synced}\n`);
  });

  it("refuses writes to new databases instead of retrying them against the files", () => {
    const target = path.join(tmpdir(), `query-mirror-write-${process.pid}.db`);
    try {
      const result = querySql(
        entries,
        `ATTACH '${target}' AS n; CREATE TABLE n.t AS SELECT 1 AS n`,
        "listed"
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Permission Error");
      expect(result.stderr).not.toContain("Queries are slower than usual");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { force: true });
    }
  });

  it("denies reading files outside the copy", () => {
    for (const mode of ["none", "listed"] as const) {
      const result = querySql(
        entries,
        "SELECT * FROM read_text('/etc/passwd')",
        mode
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Permission Error");
      expect(result.stdout).toBe("");
    }
  });

  it("denies writing files from the views over the entry files", () => {
    const target = path.join(tmpdir(), `query-mirror-copy-${process.pid}.csv`);
    try {
      const result = querySql(entries, `COPY (SELECT 1) TO '${target}'`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Permission Error");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { force: true });
    }
  });

  it("warms silently, then checks DuckDB once and reuses it for later queries", () => {
    const real =
      process.env.DUCKDB_BIN ||
      spawnSync("sh", ["-c", "command -v duckdb"], {
        encoding: "utf-8",
      }).stdout.trim();
    const mirror = mkdtempSync(path.join(tmpdir(), "query-mirror-cache-"));
    try {
      mkdirSync(path.join(mirror, "sample-docs"));
      mkdirSync(path.join(mirror, ".bin"));
      mkdirSync(path.join(mirror, ".tmp"));
      for (const entry of entries) {
        const file = path.join(mirror, "sample-docs", `${entry.sys.id}.md`);
        writeFileSync(file, renderMirrorFile(entry, "sample-docs"));
        writeFileSync(
          mirrorDataPath(file),
          renderMirrorData(entry, "sample-docs")
        );
      }
      writeFileSync(
        path.join(mirror, "manifest.json"),
        JSON.stringify({ syncedAt: "2026-10-09T03:00:10.000Z" })
      );
      // A Drive binary that records each version check before running the real DuckDB.
      const log = path.join(mirror, "checks.log");
      writeFileSync(
        path.join(mirror, ".bin", "duckdb"),
        `#!/bin/sh\n[ "\${1:-}" = --version ] && echo check >> "${log}"\nexec "${real}" "$@"\n`,
        { mode: 0o755 }
      );
      const { DUCKDB_BIN: _override, ...env } = process.env;
      const run = (arg: string) =>
        spawnSync("sh", [SQL_SCRIPT, arg], {
          encoding: "utf-8",
          env: {
            ...env,
            CONTENTFUL_DIR: mirror,
            TMPDIR: path.join(mirror, ".tmp"),
          },
        });

      const warm = run("--warm");
      expect(warm.status, warm.stderr).toBe(0);
      expect(warm.stdout).toBe("");
      for (const _ of [1, 2]) {
        const result = run("SELECT count(*) AS n FROM entries");
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.split("\n")[1]).toBe("7");
      }
      expect(readFileSync(log, "utf-8")).toBe("check\n");

      // A newer sync can ship another DuckDB, so it gets its own copy and check.
      writeFileSync(
        path.join(mirror, "manifest.json"),
        JSON.stringify({ syncedAt: "2026-10-10T03:00:10.000Z" })
      );
      writeFileSync(
        path.join(mirror, ".bin", "duckdb"),
        `#!/bin/sh\n[ "\${1:-}" = --version ] && echo check2 >> "${log}"\nexec "${real}" "$@"\n`,
        { mode: 0o755 }
      );
      const newer = run("SELECT count(*) AS n FROM entries");
      expect(newer.status, newer.stderr).toBe(0);
      expect(newer.stdout.split("\n")[1]).toBe("7");
      expect(readFileSync(log, "utf-8")).toBe("check\ncheck2\n");
    } finally {
      rmSync(mirror, { force: true, recursive: true });
    }
  });

  it("copies the database to local disk while warming and queries the copy", () => {
    const mirror = mkdtempSync(path.join(tmpdir(), "query-mirror-local-"));
    try {
      mkdirSync(path.join(mirror, "sample-docs"));
      mkdirSync(path.join(mirror, ".tmp"));
      writeFileSync(
        path.join(mirror, "content-types.ndjson"),
        renderSchemaLines("sample-docs", [guideSchema])
      );
      writeFileSync(path.join(mirror, "users.ndjson"), "");
      for (const entry of entries) {
        const file = path.join(mirror, "sample-docs", `${entry.sys.id}.md`);
        writeFileSync(file, renderMirrorFile(entry, "sample-docs"));
        writeFileSync(
          mirrorDataPath(file),
          renderMirrorData(entry, "sample-docs")
        );
      }
      buildTestDatabase(mirror);
      writeFileSync(
        path.join(mirror, "manifest.json"),
        JSON.stringify({
          database: "mirror.duckdb",
          syncedAt: "2026-10-09T03:00:10.000Z",
        })
      );
      const run = (arg: string) =>
        spawnSync("sh", [SQL_SCRIPT, arg], {
          encoding: "utf-8",
          env: {
            ...process.env,
            CONTENTFUL_DIR: mirror,
            TMPDIR: path.join(mirror, ".tmp"),
          },
        });

      const warm = run("--warm");
      expect(warm.status, warm.stderr).toBe(0);
      expect(warm.stdout + warm.stderr).toBe("");
      // With the Drive's database gone, only the local copy can answer.
      rmSync(path.join(mirror, "mirror.duckdb"));
      const result = run("SELECT source FROM marker");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split("\n").slice(0, 2)).toEqual([
        "source",
        "database",
      ]);
    } finally {
      rmSync(mirror, { force: true, recursive: true });
    }
  });

  it("names the fallback tools when the files are missing", () => {
    const result = spawnSync("sh", [SQL_SCRIPT, "SELECT 1"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        CONTENTFUL_DIR: path.join(tmpdir(), "no-contentful"),
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run_contentful_query");
    expect(result.stderr).toContain("get_contentful_schema");
  });

  it("refuses DuckDB dot-commands", () => {
    const result = querySql(entries, ".shell echo escaped");
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("escaped");
    expect(result.stderr).toContain("Only SQL statements are accepted.");
  });

  it("warms silently when the files are missing", () => {
    const result = spawnSync("sh", [SQL_SCRIPT, "--warm"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        CONTENTFUL_DIR: path.join(tmpdir(), "no-contentful"),
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("lists each content type's fields with their constraints and link targets", () => {
    const sql =
      "SELECT fieldId, type, required, itemType, itemAllowedContentTypeIds FROM type_fields WHERE contentTypeId = 'guide' ORDER BY fieldId";
    const expected = [
      "fieldId,type,required,itemType,itemAllowedContentTypeIds",
      "body,RichText,false,NULL,NULL",
      "related,Array,false,Link,[guide]",
      "title,Symbol,true,NULL,NULL",
    ];
    for (const mode of ["none", "listed"] as const) {
      const result = querySql(entries, sql, mode);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split("\n").slice(0, 4)).toEqual(expected);
    }
  });

  it("joins the schema to entries to find required fields with no value", () => {
    const untitled = typed(
      {
        fields: { slug: { "en-US": "draft" } },
        sys: { id: "untitled", version: 1 },
      },
      "guide"
    );
    const result = querySql(
      [...entries, untitled],
      "SELECT string_agg(e.entryId) AS ids FROM entries e JOIN type_fields f ON f.space = e.space AND f.contentTypeId = e.contentType WHERE f.required AND f.fieldId = 'title' AND json_extract_string(e.fields, '$.title') IS NULL"
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[1]).toBe("untitled");
  });

  it("keeps working with empty schema tables for copies synced before schemas were stored", () => {
    const result = querySql(
      entries,
      "SELECT (SELECT count(*) FROM content_types) AS types, (SELECT count(*) FROM entries) AS entries",
      "none",
      false
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[1]).toBe("0,7");
  });

  describe("users", () => {
    const usersFile = [
      user("sample-docs", "user1", "Ada Lovelace"),
      user("sample-docs", "user2", null),
      user("sample-site", "user1", "Site Editor"),
    ].join("");
    const edited = [
      editedBy("a", "Alpha", "user1"),
      editedBy("b", "Beta", "user2"),
      editedBy("c", "Gamma", "gone"),
    ];
    const lastEditors =
      "SELECT e.title, u.name FROM entries e LEFT JOIN users u ON u.space = e.space AND u.userId = e.updatedBy ORDER BY e.title";

    it("lists each space's users from the files and the database", () => {
      for (const database of ["none", "listed"] as const) {
        const [result] = queryMirror(
          edited,
          ["SELECT space, userId, name FROM users ORDER BY space, userId"],
          { database, users: usersFile }
        );
        expect(result?.status, result?.stderr).toBe(0);
        expect(result?.stderr).toBe("");
        expect(result?.stdout.split("\n").slice(0, 5)).toEqual([
          "space,userId,name",
          "sample-docs,user1,Ada Lovelace",
          "sample-docs,user2,NULL",
          "sample-site,user1,Site Editor",
          `# 3 rows; ${synced}`,
        ]);
      }
    });

    it("names who last updated each entry, within its own space", () => {
      for (const database of ["none", "listed"] as const) {
        const [result] = queryMirror(edited, [lastEditors], {
          database,
          siteEntries: [editedBy("s", "Site page", "user1")],
          users: usersFile,
        });
        expect(result?.status, result?.stderr).toBe(0);
        expect(result?.stdout.split("\n").slice(0, 5)).toEqual([
          "title,name",
          "Alpha,Ada Lovelace",
          "Beta,NULL",
          "Gamma,NULL",
          "Site page,Site Editor",
        ]);
      }
    });

    it("keeps working with an empty users file", () => {
      for (const database of ["none", "listed"] as const) {
        const [count, join] = queryMirror(
          edited,
          ["SELECT count(*) AS n FROM users", lastEditors],
          { database, users: "" }
        );
        expect(count?.status, count?.stderr).toBe(0);
        expect(count?.stdout.split("\n")[1]).toBe("0");
        expect(join?.status, join?.stderr).toBe(0);
        expect(join?.stdout.split("\n").slice(0, 4)).toEqual([
          "title,name",
          "Alpha,NULL",
          "Beta,NULL",
          "Gamma,NULL",
        ]);
      }
    });

    it("keeps working with an empty users table for copies synced before users were stored", () => {
      const [result] = queryMirror(
        edited,
        [
          "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM entries) AS entries",
        ],
        { users: null }
      );
      expect(result?.status, result?.stderr).toBe(0);
      expect(result?.stdout.split("\n")[1]).toBe("0,3");
    });

    it("answers from the files when the database predates the users table", () => {
      const [users, title] = queryMirror(
        edited,
        [
          "SELECT name FROM users WHERE userId = 'user1'",
          "SELECT title FROM entries WHERE entryId = 'a'",
        ],
        { database: "nousers", users: usersFile }
      );
      for (const result of [users, title]) {
        expect(result?.status, result?.stderr).toBe(0);
        expect(result?.stderr).toContain("Queries are slower than usual");
      }
      expect(users?.stdout.split("\n")[1]).toBe("Ada Lovelace");
      expect(title?.stdout.split("\n")[1]).toBe("Alpha");
    });
  });
});
