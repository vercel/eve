/**
 * Compacted DuckDB database built from the mirror's JSON sidecars and Markdown files.
 * The sync builds it inside its sandbox with a pinned DuckDB binary stored on the Drive,
 * which agent sessions also use to query it.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { MIRROR_PATH } from "./files";

/* Database file the search_content skill opens read-only when the manifest lists it. */
export const MIRROR_DATABASE_FILE = "mirror.duckdb";
export const MIRROR_DATABASE_PATH = `${MIRROR_PATH}/${MIRROR_DATABASE_FILE}`;

/* Built beside the final path so the rename that publishes it stays on one filesystem. */
const BUILD_PATH = `${MIRROR_PATH}/.${MIRROR_DATABASE_FILE}.tmp`;

/* DuckDB binary kept on the Drive; the directory name keeps it out of entry globs. */
export const DUCKDB_PATH = `${MIRROR_PATH}/.bin/duckdb`;

/* Pinned DuckDB CLI release, verified by SHA-256 of the downloaded .gz asset. */
export const DUCKDB_VERSION = "1.5.6";
/* Bounds the binary download, including its body, so a stalled response cannot hold the sync until the sandbox times out. */
const DUCKDB_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

/** Download URL and SHA-256 of a gzipped DuckDB CLI, keyed by `uname -m`. */
export type DuckdbAssets = Record<string, { sha256: string; url: string }>;

const DUCKDB_ASSETS = {
  aarch64: {
    sha256: "1af0541e649a3ae34eb20eec2ca564308bf0e8993e5d6dba6be77bfb289a2718",
    url: `https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-arm64.gz`,
  },
  x86_64: {
    sha256: "cce2687a38681db644c248198b99ecd86170ff47e324c5f33e50c0042f142839",
    url: `https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-amd64.gz`,
  },
} satisfies DuckdbAssets;

const REFERENCE_TYPE =
  "STRUCT(field VARCHAR, id VARCHAR, linkType VARCHAR, nodeType VARCHAR, path VARCHAR, relationship VARCHAR)[]";

const SCHEMA_FIELD_TYPE =
  "STRUCT(id VARCHAR, name VARCHAR, type VARCHAR, linkType VARCHAR, required BOOLEAN, localized BOOLEAN, allowedContentTypeIds VARCHAR[], items STRUCT(type VARCHAR, linkType VARCHAR, allowedContentTypeIds VARCHAR[]), richTextReferences STRUCT(nodeType VARCHAR, linkType VARCHAR, allowedContentTypeIds VARCHAR[])[])[]";

const SCHEMA_COLUMNS = `'space': 'VARCHAR', 'contentTypeId': 'VARCHAR', 'name': 'VARCHAR', 'description': 'VARCHAR', 'displayField': 'VARCHAR', 'fields': '${SCHEMA_FIELD_TYPE}'`;

/* Each entry's text as search() reads it; mirrorBuildSql stores it as a table. */
const SEARCH_TEXT_VIEW = String.raw`-- Each entry's searchable text: its non-blank lines after the metadata block, whitespace
-- collapsed, without "## /field" headings. searched puts the title on a line before them.
CREATE VIEW search_text AS
SELECT space, entryId, body,
       CASE WHEN length(opening) <= 200 THEN opening ELSE left(opening, 200) || '…' END AS opening,
       coalesce(title, '') || chr(10) || body AS searched
FROM (
  SELECT e.space, e.entryId, replace(e.title, chr(1), '') AS title,
         array_to_string(t.lines, chr(10)) AS body, array_to_string(t.lines, ' ') AS opening
  FROM (
    SELECT regexp_extract(filename, '([^/]+)/([^/]+)\.md$', ['space', 'entryId']) AS id,
           [line FOR line IN [trim(regexp_replace(raw, '\s+', ' ', 'g'))
              FOR raw IN string_split(regexp_replace(replace(content, chr(1), ''), '^---\r?\n(?s:.*?)\r?\n---\r?\n', ''), chr(10))]
            IF line <> '' AND NOT starts_with(line, '## /')] AS lines
    FROM pages
  ) t
  JOIN entries e ON e.space = t.id.space AND e.entryId = t.id.entryId
);`;

/*
 * The search term as literal alternatives: lowercased, whitespace collapsed, spaces around
 * "|" and at either end removed, empty alternatives dropped, and every regex character
 * other than "|" escaped. It is inlined wherever the pattern is used, so that a constant
 * term folds into one compiled pattern instead of a per-row one.
 */
const SEARCH_ALTERNATIVES = String.raw`regexp_replace(trim(regexp_replace(regexp_replace(regexp_replace(lower(term), '\s+', ' ', 'g'), ' ?\| ?', '|', 'g'), '\|+', '|', 'g'), '| '), '[.+*?(){}^$\[\]\\]', '\\\0', 'g')`;

/* Whole-word match ignoring case; letters, digits, and "_" in any script are word characters. */
const SEARCH_PATTERN = String.raw`('(?im)(^|[^\pL\pN_\n])(' || ${SEARCH_ALTERNATIVES} || ')([^\pL\pN_\n]|$)')`;

/* Replaces each match with a marker, keeping the boundary characters around it. */
const markMatches = (text: string): string =>
  String.raw`regexp_replace(${text}, ${SEARCH_PATTERN}, '\1' || chr(1) || '\3', 'g')`;

/*
 * Full-text search over each entry's title and page text, read from `search_text`. Counting
 * marks matches twice because a match consumes the boundary character the next match needs.
 * Table names stay unqualified, so they bind when the macro is called, to the session's
 * default database: the database file itself when the search_content skill opens it alone.
 */
const searchMacroSql = (name: string): string =>
  String.raw`CREATE MACRO ${name}(term) AS TABLE
SELECT e.space, e.entryId, e.contentType, e.status, e.title, e.url, e.contentfulUrl, e.updatedAt,
       m.mentions, m.opening, m.passages
FROM (
  SELECT space, entryId, opening,
         length(marked) - length(replace(marked, chr(1), '')) AS mentions,
         [CASE WHEN length(line) <= 200 THEN line
               ELSE '…' || substr(line, greatest(1, instr(line, regexp_extract(line, ${SEARCH_PATTERN})) - 80), 200) || '…' END
          FOR line IN [line FOR line IN string_split(body, chr(10)) IF regexp_matches(line, ${SEARCH_PATTERN})][1:3]] AS passages
  FROM (
    SELECT space, entryId, opening, body, ${markMatches(markMatches("searched"))} AS marked
    FROM search_text
    WHERE ${SEARCH_ALTERNATIVES} <> '' AND regexp_matches(searched, ${SEARCH_PATTERN})
  )
) m
JOIN entries e ON e.space = m.space AND e.entryId = m.entryId;
`;

/**
 * Builds the SQL that defines the entry, link, text, schema, and user views over a mirror root.
 *
 * @param root - Absolute mirror directory containing one folder per space.
 * @returns SQL text; the search_content skill ships the output for `/contentful` as `views.sql`.
 */
export const mirrorViewsSql = (root: string): string =>
  `-- Views over the Contentful mirror. Generated by agent/lib/contentful/mirror/database.ts.
SET enable_progress_bar = false;

CREATE VIEW entries AS
SELECT * FROM read_json(
  '${root}/*/*.json',
  format = 'newline_delimited',
  columns = {
    'entryId': 'VARCHAR', 'space': 'VARCHAR', 'contentType': 'VARCHAR',
    'status': 'VARCHAR', 'title': 'VARCHAR', 'slug': 'VARCHAR',
    'url': 'VARCHAR', 'contentfulUrl': 'VARCHAR', 'date': 'VARCHAR',
    'version': 'INTEGER',
    'createdAt': 'TIMESTAMPTZ', 'updatedAt': 'TIMESTAMPTZ',
    'publishedAt': 'TIMESTAMPTZ', 'firstPublishedAt': 'TIMESTAMPTZ',
    'createdBy': 'VARCHAR', 'updatedBy': 'VARCHAR', 'publishedBy': 'VARCHAR',
    'fields': 'JSON',
    'references': '${REFERENCE_TYPE}'
  }
);

-- One row per link, joined to the target's type and title when the target is mirrored.
CREATE VIEW refs AS
SELECT e.space, e.entryId AS fromId, e.contentType AS fromType,
       e.r.field, e.r.path, e.r.nodeType, e.r.relationship, e.r.linkType,
       e.r.id AS toId, t.contentType AS toType, t.title AS toTitle
FROM (SELECT space, entryId, contentType, unnest("references") AS r FROM entries) e
LEFT JOIN entries t ON e.r.linkType = 'Entry' AND t.space = e.space AND t.entryId = e.r.id;

-- Raw Markdown text; search(term) below counts whole-word matches in it.
CREATE VIEW pages AS
SELECT filename, content FROM read_text('${root}/*/*.md');

-- One row per content type in each configured space.
CREATE VIEW content_types AS
SELECT space, contentTypeId, name, description, displayField
FROM read_json(
  '${root}/content-types.ndjson',
  format = 'newline_delimited',
  columns = {${SCHEMA_COLUMNS}}
);

-- One row per field of each content type, with its constraints and allowed link targets.
CREATE VIEW type_fields AS
SELECT space, contentTypeId, f.id AS fieldId, f.name, f.type, f.linkType,
       f.required, f.localized, f.allowedContentTypeIds,
       f.items.type AS itemType, f.items.linkType AS itemLinkType,
       f.items.allowedContentTypeIds AS itemAllowedContentTypeIds,
       f.richTextReferences
FROM (
  SELECT space, contentTypeId, unnest(fields) AS f
  FROM read_json(
    '${root}/content-types.ndjson',
    format = 'newline_delimited',
    columns = {${SCHEMA_COLUMNS}}
  )
);

-- One row per user in each configured space; join userId to createdBy, updatedBy, or
-- publishedBy for names. name is null when Contentful has none.
CREATE VIEW users AS
SELECT space, userId, name
FROM read_json(
  '${root}/users.ndjson',
  format = 'newline_delimited',
  columns = {'space': 'VARCHAR', 'userId': 'VARCHAR', 'name': 'VARCHAR'}
);

${SEARCH_TEXT_VIEW}
-- search(term): one row per entry whose title or text mentions the term as whole words,
-- ignoring case; "|" separates literal alternatives. Other metadata is not searched.
${searchMacroSql("search")}`;

/**
 * Builds the SQL that materializes the views into a fresh database file.
 *
 * @param target - Path of the new database file; it must not exist yet.
 * @param root - Mirror directory to read; tests pass a local copy.
 * @returns SQL for an in-memory DuckDB session.
 * @remarks Disabling insertion order keeps memory bounded; without it a 10,000-entry build exhausted memory.
 * The `search` macro and its `search_text` table are stored in the database so the search_content skill can call it after opening the file alone.
 */
export const mirrorBuildSql = (
  target: string,
  root: string = MIRROR_PATH
): string =>
  `${mirrorViewsSql(root)}
SET preserve_insertion_order = false;
SET temp_directory = '/tmp/duckdb-spill';
ATTACH '${target}' AS mirror;
CREATE TABLE mirror.entries AS FROM entries;
CREATE TABLE mirror.refs AS FROM refs;
CREATE TABLE mirror.pages AS FROM pages;
CREATE TABLE mirror.content_types AS FROM content_types;
CREATE TABLE mirror.type_fields AS FROM type_fields;
CREATE TABLE mirror.users AS FROM users;
CREATE TABLE mirror.search_text AS FROM search_text;
${searchMacroSql("mirror.search")}DETACH mirror;
`;

/**
 * Sandbox operations the database build uses, matching the Vercel Sandbox API.
 */
export interface DatabaseSandbox {
  runCommand: (
    command: string,
    args: string[]
  ) => Promise<{
    exitCode: number;
    stderr: () => Promise<string>;
    stdout: () => Promise<string>;
  }>;
  writeFiles: (
    files: { content: string | Uint8Array; mode?: number; path: string }[]
  ) => Promise<void>;
}

const run = async (
  sandbox: DatabaseSandbox,
  command: string,
  args: string[]
) => {
  const result = await sandbox.runCommand(command, args);
  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(
      `${command} failed in the mirror sandbox (exit ${result.exitCode}): ${stderr.trim()}`
    );
  }
  return result.stdout();
};

/*
 * Whether the Drive already holds a runnable binary of the pinned version. Vercel Sandbox
 * rejects a command it cannot start, such as a missing binary, instead of reporting an exit code.
 */
const hasPinnedDuckdb = async (sandbox: DatabaseSandbox) => {
  try {
    const result = await sandbox.runCommand(DUCKDB_PATH, ["--version"]);
    const version = await result.stdout();
    return result.exitCode === 0 && version.startsWith(`v${DUCKDB_VERSION} `);
  } catch {
    return false;
  }
};

/**
 * Ensures the pinned DuckDB binary is on the Drive, downloading it in this process.
 *
 * @param sandbox - Sandbox with the mirror Drive mounted read-write.
 * @param download - Fetch implementation; the sandbox itself has no network access. It receives an abort signal that times out after two minutes.
 * @param assets - Pinned downloads by architecture; tests substitute their own.
 * @throws {@link Error} When the architecture is unsupported, the download fails or times out, the checksum differs, or the binary cannot run.
 */
export const installDuckdb = async (
  sandbox: DatabaseSandbox,
  download: typeof fetch = fetch,
  assets: DuckdbAssets = DUCKDB_ASSETS
): Promise<void> => {
  if (await hasPinnedDuckdb(sandbox)) {
    return;
  }
  const uname = await run(sandbox, "uname", ["-m"]);
  const arch = uname.trim();
  const asset = assets[arch];
  if (!asset) {
    throw new Error(`No pinned DuckDB binary for architecture "${arch}".`);
  }
  const response = await download(asset.url, {
    signal: AbortSignal.timeout(DUCKDB_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DuckDB download failed with HTTP ${response.status}.`);
  }
  const compressed = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(compressed).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`DuckDB download checksum mismatch: ${digest}.`);
  }
  const staged = `${DUCKDB_PATH}.tmp`;
  await run(sandbox, "mkdir", ["-p", "--", `${MIRROR_PATH}/.bin`]);
  await sandbox.writeFiles([
    { content: gunzipSync(compressed), mode: 0o755, path: staged },
  ]);
  await run(sandbox, "mv", ["-f", "--", staged, DUCKDB_PATH]);
  if (!(await hasPinnedDuckdb(sandbox))) {
    throw new Error(
      "The installed DuckDB binary does not run in the mirror sandbox."
    );
  }
};

/**
 * Rebuilds the compacted database from the mirror files and swaps it into place.
 *
 * @param sandbox - Sandbox with the mirror Drive mounted read-write.
 * @param download - Fetch implementation used only when the binary must be installed.
 * @throws {@link Error} When installing DuckDB or building the database fails; the previous file is left in place.
 */
export const buildMirrorDatabase = async (
  sandbox: DatabaseSandbox,
  download: typeof fetch = fetch
): Promise<void> => {
  await installDuckdb(sandbox, download);
  await run(sandbox, "rm", ["-f", "--", BUILD_PATH, `${BUILD_PATH}.wal`]);
  await run(sandbox, DUCKDB_PATH, ["-c", mirrorBuildSql(BUILD_PATH)]);
  await run(sandbox, "mv", ["-f", "--", BUILD_PATH, MIRROR_DATABASE_PATH]);
};
