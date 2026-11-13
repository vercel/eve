import { z } from "zod";

import type { JsonValue } from "../../json";
import { isObject, isString } from "../../values";
import { contentSections, queryFieldReferences } from "../content";
import type { QueryReference } from "../content";
/**
 * Layout, rendering, and manifest of the Contentful mirror stored on a Vercel Drive.
 * The mirror is a discovery index only: Contentful stays the source of truth.
 *
 * @packageDocumentation
 */
import { contentLocale } from "../locale";
import { CONTENTFUL_ID } from "../model";
import type { ListableKind } from "../model";
import type { RawSpaceUser } from "../query";
import { describeContentTypeField } from "../schema";
import { summarizeEntry } from "../summary";
import type { LocalizedFields, RawContentType, RawEntry } from "../types";

/* Drive name, unique within the Vercel project. */
export const MIRROR_DRIVE_NAME =
  process.env.CONTENTFUL_MIRROR_DRIVE_NAME || "contentful-mirror";

/* Drive region. Sandboxes that mount the Drive must run in the same region. */
export const MIRROR_REGION = process.env.CONTENTFUL_MIRROR_REGION || "iad1";

/* Absolute mount path of the mirror in the sync sandbox and in agent sessions. */
export const MIRROR_PATH = "/contentful";

/* Written last by every successful sync, so its timestamps bound what the mirror covers. */
export const MIRROR_MANIFEST_PATH = `${MIRROR_PATH}/manifest.json`;

/*
 * Content type definitions for every configured space, one JSON line per type. It sits at
 * the mirror root with its own extension, because entry globs such as `*\/*.json` also
 * match hidden folders.
 */
export const MIRROR_SCHEMA_PATH = `${MIRROR_PATH}/content-types.ndjson`;

/*
 * Users of every configured space, one JSON line per user per space with only the space, user
 * ID, and display name, so entry actor IDs can be resolved to names. Emails are never stored.
 */
export const MIRROR_USERS_PATH = `${MIRROR_PATH}/users.ndjson`;

/* Sync metadata stored beside the entry files. */
/**
 * Versioned sync metadata used to detect stale configuration and choose a safe incremental window.
 */
export interface MirrorManifest {
  configuration?: string;
  /** Compacted SQL database built by this sync, relative to the mirror root; absent when none was built. */
  database?: string;
  /** Mirrored entry files after the sync. */
  entryCount: number;
  /** Start of the last successful full sync, which also removes deleted entries. */
  fullSyncedAt: string;
  /** Start of the last successful sync; later Contentful edits may be missing. */
  syncedAt: string;
  version: 1;
}

/**
 * Parses persisted mirror metadata and checks the version, count, and timestamps.
 *
 * @param text - Stored manifest JSON, or null when no file exists.
 * @returns A version-one manifest, or null when missing, malformed, or unsupported.
 */
export const parseMirrorManifest = (
  text: string | null
): MirrorManifest | null => {
  if (text === null) {
    return null;
  }
  try {
    return z
      .object({
        configuration: z.string().optional(),
        database: z.string().optional(),
        entryCount: z.number().int().nonnegative(),
        fullSyncedAt: z
          .string()
          .refine((value) => !Number.isNaN(Date.parse(value))),
        syncedAt: z
          .string()
          .refine((value) => !Number.isNaN(Date.parse(value))),
        version: z.literal(1),
      })
      .parse(JSON.parse(text));
  } catch {
    // A corrupt manifest is treated like a missing one: the next sync is full.
  }
  return null;
};

/**
 * Builds the mirror path for one space-qualified entry.
 *
 * @param kind - Raw space ID used as the mirror's directory name.
 * @param entryId - Contentful entry ID used as the Markdown filename.
 * @returns An absolute mirror path, or null when either identifier is an unsafe path segment.
 */
export const mirrorFilePath = (
  kind: ListableKind,
  entryId: string
): string | null =>
  CONTENTFUL_ID.test(kind) && CONTENTFUL_ID.test(entryId)
    ? `${MIRROR_PATH}/${kind}/${entryId}.md`
    : null;

/**
 * Maps a mirrored Markdown path to its structured JSON sidecar.
 *
 * @param markdownPath - Absolute path of an entry's Markdown file.
 * @returns The sibling `.json` path that holds the entry's queryable metadata.
 */
export const mirrorDataPath = (markdownPath: string): string =>
  `${markdownPath.slice(0, -".md".length)}.json`;

/**
 * Structured, SQL-queryable record written beside each mirrored entry's Markdown.
 *
 * @remarks Text stays in the Markdown file; this record holds metadata, scalar fields, and links.
 */
interface MirrorEntryData {
  contentfulUrl: string;
  contentType: string;
  createdAt: string | null;
  createdBy: string | null;
  date: string | null;
  entryId: string;
  /** Scalar and scalar-list field values in the configured locale; rich text and links are excluded. */
  fields: Record<string, JsonValue>;
  firstPublishedAt: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Every Entry and Asset link in the configured locale, including rich-text embeds and hyperlinks. */
  references: QueryReference[];
  slug: string | null;
  space: string;
  status: string;
  title: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  url: string | null;
  version: number | null;
}

/* JSON values that are neither objects nor arrays: strings, numbers, booleans, and null. */
const isScalar = (value: JsonValue): boolean => !isObject(value);

/**
 * Renders an entry's queryable metadata, scalar fields, and references as one JSON line.
 *
 * @param entry - Locale-projected CMA entry, as passed to {@link renderMirrorFile}.
 * @param kind - Raw configured space ID containing the entry.
 * @returns Single-line JSON terminated by a newline, readable with DuckDB's `read_json`.
 */
export const renderMirrorData = (
  entry: RawEntry,
  kind: ListableKind
): string => {
  const summary = summarizeEntry(entry, kind);
  const fields: Record<string, JsonValue> = {};
  const references: QueryReference[] = [];
  for (const [key, locales] of Object.entries(entry.fields ?? {})) {
    const value = locales[contentLocale()];
    if (value === undefined) {
      continue;
    }
    const field = `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    for (const reference of queryFieldReferences(value, field)) {
      if (reference) {
        references.push(reference);
      }
    }
    if (isScalar(value) || (Array.isArray(value) && value.every(isScalar))) {
      fields[key] = value;
    }
  }
  const { sys } = entry;
  const data: MirrorEntryData = {
    contentType: sys.contentType?.sys.id ?? "unknown",
    contentfulUrl: summary.contentfulUrl,
    createdAt: sys.createdAt ?? null,
    createdBy: sys.createdBy?.sys.id ?? null,
    date: summary.date,
    entryId: summary.entryId,
    fields,
    firstPublishedAt: sys.firstPublishedAt ?? null,
    publishedAt: summary.publishedAt,
    publishedBy: sys.publishedBy?.sys.id ?? null,
    references,
    slug: summary.slug,
    space: kind,
    status: summary.status,
    title: summary.title,
    updatedAt: summary.updatedAt,
    updatedBy: sys.updatedBy?.sys.id ?? null,
    url: summary.url,
    version: sys.version ?? null,
  };
  return `${JSON.stringify(data)}\n`;
};

/* Join each top-level list of strings into one comma-separated value. */
const joinStringLists = (fields: LocalizedFields): LocalizedFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, locales]) => {
      const value = locales[contentLocale()];
      return Array.isArray(value) && value.every((item) => isString(item))
        ? [key, { ...locales, [contentLocale()]: value.join(", ") }]
        : [key, locales];
    })
  );

/**
 * Renders an entry as quoted metadata followed by searchable Markdown sections.
 *
 * @param entry - CMA entry whose configured-locale text fields should be indexed.
 * @param kind - Raw configured space ID containing the entry.
 * @returns Markdown containing entry metadata and plain-text field sections.
 * @remarks Linked entries are not inlined; rich text becomes plain text and string lists become comma-separated text.
 */
export const renderMirrorFile = (
  entry: RawEntry,
  kind: ListableKind
): string => {
  const summary = summarizeEntry(entry, kind);
  // Tuples keep the metadata in reading order.
  const metadata: [string, string | number | null][] = [
    ["entryId", summary.entryId],
    ["space", kind],
    ["kind", entry.sys.contentType?.sys.id ?? "unknown"],
    ["status", summary.status],
    ["title", summary.title],
    ["slug", summary.slug],
    ["url", summary.url],
    ["contentfulUrl", summary.contentfulUrl],
    ["date", summary.date],
    ["version", entry.sys.version ?? null],
    ["updatedAt", summary.updatedAt],
    ["publishedAt", summary.publishedAt],
  ];
  const lines = [
    "---",
    ...metadata.map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
  ];
  const {
    title: _title,
    slug: _slug,
    date: _date,
    ...textFields
  } = entry.fields ?? {};
  for (const { field, text } of contentSections(joinStringLists(textFields))) {
    lines.push("", `## ${field}`, "", text);
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Renders a space's content types as newline-delimited JSON for the schema tables.
 *
 * @param space - Raw configured space ID that owns the content types.
 * @param models - Every content type in the space, as returned by the CMA.
 * @returns One JSON line per content type with its fields described like the live schema tool.
 */
export const renderSchemaLines = (
  space: string,
  models: RawContentType[]
): string =>
  models
    .map(
      (model) =>
        `${JSON.stringify({
          contentTypeId: model.sys.id,
          description: model.description ?? null,
          displayField: model.displayField ?? null,
          fields: model.fields.map(describeContentTypeField),
          name: model.name,
          space,
        })}\n`
    )
    .join("");

/**
 * Renders a space's users as newline-delimited JSON for the users table.
 *
 * @param space - Raw configured space ID the users belong to, matching {@link renderSchemaLines}.
 * @param users - Space users as returned by the CMA.
 * @returns One `{"space","userId","name"}` JSON line per user; the name is the trimmed first and last name, or null when both are empty.
 * @remarks Users with an unsafe or overlong ID are skipped. Only the three keys are written, so emails and other profile fields never reach the mirror.
 */
export const renderUserLines = (space: string, users: RawSpaceUser[]): string =>
  users
    .filter(({ sys }) => sys.id.length <= 128 && CONTENTFUL_ID.test(sys.id))
    .map((user) => {
      const name = [user.firstName?.trim(), user.lastName?.trim()]
        .filter(Boolean)
        .join(" ");
      return `${JSON.stringify({
        name: name.length === 0 ? null : name,
        space,
        userId: user.sys.id,
      })}\n`;
    })
    .join("");
