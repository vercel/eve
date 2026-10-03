import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { AgentSkillDescription } from "#channel/agent-description.js";
import {
  comparePaths,
  isSkillEntryFileName,
  MAX_SKILL_FILE_BYTES,
  SKILL_ENTRY_FILE_NAME,
  type SkillFileEntry,
  type SkillFileSource,
  SkillReadError,
} from "#channel/skill-files.js";
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "#compiled/@modelcontextprotocol/server/index.js";
import { z } from "#compiled/zod/index.js";
import { parseFrontmatter } from "#internal/helpers/frontmatter.js";
import { createLogger } from "#internal/logging.js";
import {
  MCP_LIST_CACHE_HINT,
  type McpServerFeature,
} from "#internal/mcp/streamable-http-server.js";
import type { JsonObject } from "#shared/json.js";

/** SEP-2640 extension identifier. */
export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** SEP-2640 limits a conforming host must accept; skills over them are not served. */
export const MCP_SKILL_MAX_RESOURCES = 512;
export const MCP_SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const SKILL_URI_PREFIX = "skill://";
const DIRECTORY_MIME_TYPE = "inode/directory";
/** Files read concurrently while building one skill entry. */
const READ_CONCURRENCY = 8;

const log = createLogger("mcp.skills");
const warned = new Set<string>();

/** Logs why a skill is not served, once per process. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  log.warn(message);
}

/** The skills the feature serves and where their files are. */
export interface McpSkillSource {
  /** The agent's skills as `describe()` lists them. */
  readonly skills: readonly AgentSkillDescription[];
  readonly files: SkillFileSource;
}

/** One `skills/list` entry. */
interface McpSkillEntry {
  readonly uri: string;
  readonly frontmatter: JsonObject;
  readonly resources: readonly {
    readonly uri: string;
    readonly digest: string;
    readonly size: number;
  }[];
}

/**
 * An MCP server feature publishing an agent's compiled skills per SEP-2640:
 * `skills/list`, `skills/get`, `resources/list`, `resources/templates/list`,
 * `resources/read`, and `resources/directory/read`, all under `skill://`.
 *
 * The feature owns the server's resource methods. They are set on the
 * low-level server rather than through `McpServer.registerResource`, whose
 * `resources/read` normalizes the URI with `new URL()` (which resolves `..`)
 * before matching.
 *
 * A skill is served whole or not at all, and an unserved skill is absent
 * from every method. It is served when:
 *
 * - its name and every file path are valid `skill://` segments, and exactly
 *   one top-level file is its entry (`SKILL.md` in any case, served as
 *   `SKILL.md`);
 * - it has at most 512 files, none over the 512 KiB skill file cap, and at
 *   most 16 MiB in total;
 * - every file reads, and the served `SKILL.md` frontmatter meets the Agent
 *   Skills format (name rules, description of 1-1024 characters).
 *
 * `SKILL.md` frontmatter that already carries the skill's `name` and a
 * `description` is served byte for byte. Otherwise (flat and module skills,
 * whose materialized `SKILL.md` has no frontmatter, or a package whose `name`
 * differs from its directory) the served document carries rewritten
 * frontmatter, and `frontmatter` and the digest describe that document.
 *
 * Snapshots are keyed by the `skills` array, which `describe()` keeps for
 * as long as the compiled artifacts stay the same, so a skill's files are
 * listed and read once per build: once per process in production, once per
 * recompile under `eve dev`.
 */
export function createMcpSkillsFeature(source: McpSkillSource): McpServerFeature {
  return {
    capabilities: {
      // eve never sends `notifications/resources/list_changed`; the SDK
      // would advertise it for a bare `{}`.
      resources: { listChanged: false },
      extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
    },
    register(server) {
      registerSkillHandlers(server, source.files, createSkillCatalog(source));
    },
  };
}

interface SnapshotFile {
  readonly mimeType: string;
  readonly size: number;
}

interface SkillSnapshot {
  readonly name: string;
  readonly description: string;
  readonly entry: McpSkillEntry;
  /** The served `SKILL.md`, which can differ from the authored one. */
  readonly document: ServedFile;
  /** Served files by path, sorted by path. */
  readonly files: ReadonlyMap<string, SnapshotFile>;
}

interface SkillCatalog {
  served(): Promise<SkillSnapshot[]>;
  skill(name: string): Promise<SkillSnapshot | undefined>;
}

const snapshotCache = new WeakMap<
  readonly AgentSkillDescription[],
  Map<string, Promise<SkillSnapshot | undefined>>
>();

function createSkillCatalog({ files, skills }: McpSkillSource): SkillCatalog {
  const snapshots =
    snapshotCache.get(skills) ?? new Map<string, Promise<SkillSnapshot | undefined>>();
  snapshotCache.set(skills, snapshots);
  const snapshot = async (name: string) => {
    const skill = skills.find((entry) => entry.name === name);
    if (skill === undefined) return undefined;
    let pending = snapshots.get(name);
    if (pending === undefined) {
      pending = snapshotSkill(files, skill);
      snapshots.set(name, pending);
      // A thrown listing or read is retried on the next request rather than cached.
      pending.catch(() => snapshots.delete(name));
    }
    return await pending;
  };
  return {
    async served() {
      const names = skills.map((skill) => skill.name).sort(comparePaths);
      const result: SkillSnapshot[] = [];
      for (const name of names) {
        const built = await snapshot(name);
        if (built !== undefined) result.push(built);
      }
      return result;
    },
    skill: snapshot,
  };
}

function registerSkillHandlers(
  server: McpServer,
  files: SkillFileSource,
  catalog: SkillCatalog,
): void {
  const low = server.server;

  low.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async (params) => {
      rejectCursor(params.cursor);
      const skills = (await catalog.served()).map((snapshot) => snapshot.entry);
      return { skills, ...MCP_LIST_CACHE_HINT };
    },
  );

  low.setRequestHandler(
    "skills/get",
    { params: z.looseObject({ uri: z.string() }) },
    async (params) => {
      const parsed = parseSkillUri(params.uri);
      const snapshot =
        parsed?.path === SKILL_ENTRY_FILE_NAME ? await catalog.skill(parsed.skill) : undefined;
      if (snapshot === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${params.uri}`, {
          uri: params.uri,
        });
      }
      return { skill: snapshot.entry, ...MCP_LIST_CACHE_HINT };
    },
  );

  low.setRequestHandler(
    "resources/directory/read",
    { params: z.looseObject({ uri: z.string(), cursor: z.string().optional() }) },
    async (params) => {
      rejectCursor(params.cursor);
      const parsed = parseSkillUri(params.uri);
      const snapshot = parsed === undefined ? undefined : await catalog.skill(parsed.skill);
      const resources = snapshot === undefined ? undefined : listDirectory(snapshot, parsed?.path);
      if (resources === undefined) throw new ResourceNotFoundError(params.uri);
      return { resources, ...MCP_LIST_CACHE_HINT };
    },
  );

  low.setRequestHandler("resources/list", async (request) => {
    rejectCursor(request.params?.cursor);
    const resources = (await catalog.served()).map((snapshot) => ({
      uri: snapshot.entry.uri,
      name: snapshot.name,
      description: snapshot.description,
      mimeType: mimeTypeFor(SKILL_ENTRY_FILE_NAME),
      size: snapshot.document.bytes.byteLength,
    }));
    return { resources };
  });

  low.setRequestHandler("resources/templates/list", async (request) => {
    rejectCursor(request.params?.cursor);
    return { resourceTemplates: [] };
  });

  low.setRequestHandler("resources/read", async (request) => {
    const uri = request.params?.uri;
    if (typeof uri !== "string") {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "params.uri must be a string.");
    }
    const parsed = parseSkillUri(uri);
    const snapshot = parsed?.path === undefined ? undefined : await catalog.skill(parsed.skill);
    const file = parsed?.path === undefined ? undefined : snapshot?.files.get(parsed.path);
    if (snapshot === undefined || parsed?.path === undefined || file === undefined) {
      throw new ResourceNotFoundError(uri);
    }
    // Only `SKILL.md` is held in memory; other files are read again, so a
    // cached snapshot costs its metadata, not every file's bytes.
    const served =
      parsed.path === SKILL_ENTRY_FILE_NAME
        ? snapshot.document
        : toServedFile(await files.readFile(snapshot.name, parsed.path));
    const contents =
      served.text === undefined
        ? { uri, mimeType: file.mimeType, blob: Buffer.from(served.bytes).toString("base64") }
        : { uri, mimeType: file.mimeType, text: served.text };
    return { contents: [contents] };
  });
}

// ---------- Snapshots ----------

interface ServedFile {
  readonly bytes: Uint8Array;
  /** Set when the file is UTF-8 text without NUL bytes. */
  readonly text?: string;
}

function toServedFile(bytes: Uint8Array): ServedFile {
  const text = decodeText(bytes);
  return text === undefined ? { bytes } : { bytes, text };
}

/** Decodes UTF-8 text without NUL bytes; returns `undefined` for anything else. */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The authored paths of a skill keyed by served path, or why it is not
 * served. Decided from the listing alone, before any file is read.
 */
function servedPaths(
  skill: string,
  files: readonly SkillFileEntry[],
): Map<string, string> | string {
  if (!isSafeSegment(skill)) return "its name is not a valid skill:// segment";
  if (files.length > MCP_SKILL_MAX_RESOURCES) {
    return `it has more than ${MCP_SKILL_MAX_RESOURCES} files`;
  }
  const paths = new Map<string, string>();
  let total = 0;
  for (const { path, size } of files) {
    if (!path.split("/").every(isSafeSegment)) {
      return `its file "${path}" is not a valid skill:// path`;
    }
    if (size > MAX_SKILL_FILE_BYTES) {
      return `its file "${path}" is over ${MAX_SKILL_FILE_BYTES} bytes`;
    }
    total += size;
    const served = !path.includes("/") && isSkillEntryFileName(path) ? SKILL_ENTRY_FILE_NAME : path;
    if (paths.has(served)) return `it has more than one ${SKILL_ENTRY_FILE_NAME}`;
    paths.set(served, path);
  }
  if (!paths.has(SKILL_ENTRY_FILE_NAME)) return `it has no ${SKILL_ENTRY_FILE_NAME}`;
  if (total > MCP_SKILL_MAX_TOTAL_BYTES) {
    return `its files total more than ${MCP_SKILL_MAX_TOTAL_BYTES} bytes`;
  }
  return paths;
}

/**
 * Lists a skill once and reads every file to build its entry. `undefined`
 * when it is not served.
 */
async function snapshotSkill(
  source: SkillFileSource,
  skill: AgentSkillDescription,
): Promise<SkillSnapshot | undefined> {
  const unserved = (reason: string) => {
    warnOnce(`mcpChannel does not serve the skill "${skill.name}": ${reason}.`);
    return undefined;
  };
  const paths = servedPaths(skill.name, await source.listFiles(skill.name));
  if (typeof paths === "string") return unserved(paths);

  const entries = [...paths.entries()].sort(([left], [right]) => comparePaths(left, right));
  // Only `SkillReadError` is deterministic for this build; anything else
  // (a transient asset or disk read failure) propagates so the catalog evicts
  // the pending snapshot and retries on the next request.
  const read = await mapWithConcurrency(entries, READ_CONCURRENCY, async ([, authored]) => {
    try {
      return toServedFile(await source.readFile(skill.name, authored));
    } catch (error) {
      if (error instanceof SkillReadError) return error.message;
      throw error;
    }
  });
  const failed = read.find((file): file is string => typeof file === "string");
  if (failed !== undefined) return unserved(`a file did not read (${failed})`);
  const files = read as ServedFile[];

  const entryIndex = entries.findIndex(([path]) => path === SKILL_ENTRY_FILE_NAME);
  const document = entryDocument(skill, files[entryIndex]!);
  if (document === undefined) {
    return unserved(
      `its ${SKILL_ENTRY_FILE_NAME} is not UTF-8 text with frontmatter that meets the Agent Skills format`,
    );
  }
  files[entryIndex] = document;
  // Sizes are checked again on the bytes read: a file can change between
  // the listing and the read, and the rewritten `SKILL.md` can grow.
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (
    total > MCP_SKILL_MAX_TOTAL_BYTES ||
    files.some((file) => file.bytes.byteLength > MAX_SKILL_FILE_BYTES)
  ) {
    return unserved("its files as read are over the size limits");
  }

  const served = new Map<string, SnapshotFile>();
  const resources: McpSkillEntry["resources"][number][] = [];
  for (const [index, [path]] of entries.entries()) {
    const file = files[index]!;
    served.set(path, { mimeType: servedMimeType(path, file), size: file.bytes.byteLength });
    resources.push({
      uri: skillFileUri(skill.name, path),
      digest: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`,
      size: file.bytes.byteLength,
    });
  }
  return {
    name: skill.name,
    description: document.description,
    document,
    entry: {
      uri: skillFileUri(skill.name, SKILL_ENTRY_FILE_NAME),
      frontmatter: document.frontmatter,
      resources,
    },
    files: served,
  };
}

interface EntryDocument extends ServedFile {
  readonly text: string;
  readonly description: string;
  readonly frontmatter: JsonObject;
}

/**
 * A skill's `SKILL.md` as served: verbatim when its frontmatter has the
 * skill's `name` and a string `description`, otherwise with frontmatter
 * rewritten to carry both. `undefined` when the result does not conform.
 */
function entryDocument(skill: AgentSkillDescription, raw: ServedFile): EntryDocument | undefined {
  if (raw.text === undefined) return undefined;
  const parsed = parseFrontmatterJson(raw.text);
  if (parsed === undefined) return undefined;
  if (
    parsed.present &&
    parsed.data.name === skill.name &&
    typeof parsed.data.description === "string"
  ) {
    return conforming({
      bytes: raw.bytes,
      description: parsed.data.description,
      frontmatter: parsed.data,
      text: raw.text,
    });
  }
  const description =
    typeof parsed.data.description === "string" ? parsed.data.description : skill.description;
  const { name: _name, description: _description, ...rest } = parsed.data;
  const text = `---\n${renderFrontmatter({ name: skill.name, description, ...rest })}---\n${parsed.content}`;
  const reparsed = parseFrontmatterJson(text);
  if (reparsed === undefined || reparsed.data.name !== skill.name) return undefined;
  return conforming({
    bytes: new TextEncoder().encode(text),
    description,
    frontmatter: reparsed.data,
    text,
  });
}

/** Agent Skills `name`: 1-64 lowercase letters, digits, and single inner hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function conforming(entry: EntryDocument): EntryDocument | undefined {
  const { name, description } = entry.frontmatter;
  if (typeof name !== "string" || typeof description !== "string") return undefined;
  if (Array.from(name).length > 64 || !SKILL_NAME_PATTERN.test(name)) return undefined;
  if (description.trim().length === 0 || Array.from(description).length > 1024) return undefined;
  return entry;
}

/**
 * Renders frontmatter as YAML with every key and value in JSON form: JSON is
 * valid YAML flow syntax, so every authored field survives without a YAML
 * serializer, and quoting keeps a name like `true` a string.
 */
function renderFrontmatter(frontmatter: JsonObject): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => {
      const renderedKey = /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) ? key : JSON.stringify(key);
      return `${renderedKey}: ${JSON.stringify(value)}\n`;
    })
    .join("");
}

function parseFrontmatterJson(
  text: string,
): { readonly present: boolean; readonly data: JsonObject; readonly content: string } | undefined {
  let data: unknown;
  let file;
  try {
    file = parseFrontmatter(text);
    // JSON as `JSON.stringify` writes it: js-yaml's `Date` timestamps become
    // ISO strings and non-finite numbers `null`, and `JSON.parse` keeps a
    // `__proto__` key as an own property instead of setting the prototype.
    data = JSON.parse(JSON.stringify(file?.data ?? {}));
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  return { content: file?.content ?? text, data: data as JsonObject, present: file !== undefined };
}

/** Direct children of a directory of a served skill; `undefined` if it is not a directory. */
function listDirectory(
  snapshot: SkillSnapshot,
  directory: string | undefined,
): { uri: string; name: string; mimeType: string }[] | undefined {
  const prefix = directory === undefined ? "" : `${directory}/`;
  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const [path, file] of snapshot.files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...below] = path.slice(prefix.length).split("/");
    if (name === undefined || children.has(name)) continue;
    const uri = skillFileUri(snapshot.name, `${prefix}${name}`);
    const mimeType = below.length === 0 ? file.mimeType : DIRECTORY_MIME_TYPE;
    children.set(name, { uri, name, mimeType });
  }
  // The skill root is always a directory; any other path is one only if a
  // served file lies below it.
  if (directory !== undefined && children.size === 0) return undefined;
  return [...children.entries()]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([, child]) => child);
}

// ---------- URIs ----------

/**
 * Parses `skill://<skill>[/<path>]` strictly. Rejected: other schemes, a
 * query or fragment, whitespace, backslashes, empty segments (so `//` and a
 * trailing `/`), `.` and `..` segments (decoded too), percent-encoded `/`,
 * `\`, or NUL, and malformed percent-encoding.
 */
export function parseSkillUri(
  uri: string,
): { readonly skill: string; readonly path?: string } | undefined {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return undefined;
  const rest = uri.slice(SKILL_URI_PREFIX.length);
  if (/[?#\\\s]/u.test(rest)) return undefined;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (!isSafeSegment(segment)) return undefined;
    segments.push(segment);
  }
  const [skill, ...path] = segments;
  if (skill === undefined) return undefined;
  return path.length === 0 ? { skill } : { skill, path: path.join("/") };
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

function skillFileUri(skill: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${SKILL_URI_PREFIX}${encodeURIComponent(skill)}/${encodedPath}`;
}

// ---------- Helpers ----------

function rejectCursor(cursor: unknown): void {
  // Every list is returned whole, so the server never issues a cursor.
  if (cursor !== undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown cursor.");
  }
}

const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["css", "text/css"],
  ["csv", "text/csv"],
  ["gif", "image/gif"],
  ["htm", "text/html"],
  ["html", "text/html"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", "text/javascript"],
  ["json", "application/json"],
  ["md", "text/markdown"],
  ["mjs", "text/javascript"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["py", "text/x-python"],
  ["sh", "text/x-shellscript"],
  ["svg", "image/svg+xml"],
  ["ts", "text/typescript"],
  ["txt", "text/plain"],
  ["webp", "image/webp"],
  ["xml", "application/xml"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
]);

/** MIME type by extension; a text file with an unknown extension is `text/plain`. */
function servedMimeType(path: string, file: ServedFile): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const known = dot <= 0 ? undefined : MIME_TYPES.get(name.slice(dot + 1).toLowerCase());
  return known ?? (file.text === undefined ? "application/octet-stream" : "text/plain");
}

function mimeTypeFor(path: string): string {
  return servedMimeType(path, { bytes: new Uint8Array() });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
