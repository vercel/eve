import type { JsonObject } from "../json";
/**
 * Shared Contentful API shapes and normalized entry contracts.
 * Raw shapes describe only the fields consumed by this library; they are not runtime validators.
 *
 * @packageDocumentation
 */
import type {
  ListableKind,
  PageKind,
  RICH_TEXT_REFERENCE_NODES,
} from "./model";

/**
 * Publishing state of an entry, derived from its `sys` version counters.
 *
 * @remarks
 * - `published`: the live version is the latest one.
 * - `changed`: published, but edited since; the live version is older.
 * - `draft`: never published.
 * - `archived`: archived, and so not served.
 */
export type EntryStatus = "published" | "changed" | "draft" | "archived";

/* An entry or asset referenced from the fetched entry's fields. */
/**
 * Compact entry or asset metadata resolved from a parent entry’s references.
 */
export interface LinkedItem extends JsonObject {
  /** Content type id; entries only. */
  contentType?: string;
  id: string;
  /** Best-effort title read from a title-like field, or null when none is a string. */
  title: string | null;
  type: "Entry" | "Asset";
  /** Absolute file URL; assets only. */
  url?: string;
}

/* A one-line view of an entry, as stored in the searchable copy. */
/**
 * One-line entry summary with publication state and available editor or website links.
 */
export interface EntrySummary extends JsonObject {
  /** Link to the entry in the Contentful web app. */
  contentfulUrl: string;
  /** The entry's editorial `date` field, or null. */
  date: string | null;
  entryId: string;
  page: ListableKind;
  publishedAt: string | null;
  slug: string | null;
  status: EntryStatus;
  title: string | null;
  updatedAt: string | null;
  /** Public configured website URL, when the entry has a slug. */
  url: string | null;
}

/* A Contentful entry flattened into a structure the model can read directly. */
/**
 * Contentful entry flattened into bounded, configured-locale fields for model consumption.
 */
export interface NormalizedEntry extends JsonObject {
  /** Link to the entry in the Contentful web app. */
  contentfulUrl: string;
  /** Content type id, e.g. `blogPost` or `guide`. */
  contentTypeId: string;
  /** ISO 8601 timestamps from `sys`, or null when absent. */
  createdAt: string | null;
  /** Ids of other entries that share the slug, when a configured website lookup was ambiguous. */
  duplicates: string[];
  entryId: string;
  environmentId: string;
  /**
   * configured-locale field values. Rich text is rendered to plain text, links become
   * {@link LinkedItem}s, and absent/null configured-locale fields are omitted.
   */
  fields: JsonObject;
  /** Best-effort linked metadata, capped at 100 entries and 100 assets; failed lookups are omitted. */
  linked: LinkedItem[];
  /**
   * The entry's page kind, from the configured website URL or from its content type
   * for a direct Contentful link. Null only for explicitly configured supporting component types.
   */
  page: PageKind | null;
  publishedAt: string | null;
  /** The entry's `slug` field, or null when it has none. */
  slug: string | null;
  spaceId: string;
  status: EntryStatus;
  /** True when any text was cut to stay within the size budget. */
  truncated: boolean;
  updatedAt: string | null;
  /** The URL as given. */
  url: string;
  /** Current entry version for an explicit update or publication proposal. */
  version: number | null;
}

/* Raw CMA link structure; consumers check supported target kinds before interpreting it. */
/**
 * CMA link metadata; consumers explicitly select supported target kinds before following it.
 */
export interface Link extends JsonObject {
  sys: {
    type: "Link";
    linkType: string;
    id: string;
  };
}

/* Consumed CMA system metadata; projected or malformed responses may omit version fields. */
/**
 * Subset of CMA system metadata consumed by this agent, including optional projected version counters.
 */
export interface RawSys extends JsonObject {
  /** Presence marks the resource archived; not a current write version. */
  archivedVersion?: number;
  contentType?: Link;
  createdAt?: string;
  createdBy?: Link;
  firstPublishedAt?: string;
  id: string;
  publishedAt?: string;
  publishedBy?: Link;
  /** Version whose content was last published; unchanged live content has version = publishedVersion + 1. */
  publishedVersion?: number;
  updatedAt?: string;
  updatedBy?: Link;
  /** Current CMA resource version used for optimistic-concurrency headers. */
  version?: number;
}

/* CMA fields indexed first by field ID and then locale; values need narrowing before use. */
/**
 * CMA fields indexed by field ID, then locale; consumers narrow each JSON value before use.
 */
export type LocalizedFields = Record<string, JsonObject>;

/* Partial CMA entry structure used for reads and write responses; fields may be omitted by projection. */
/**
 * CMA entry projection used by reads and write responses; selected fields may be absent.
 */
export interface RawEntry extends JsonObject {
  fields?: LocalizedFields;
  sys: RawSys;
}

/* Read-only asset projection for resolving linked titles and file URLs. */
/**
 * Read-only asset projection used to resolve localized titles and file URLs.
 */
export interface RawAsset extends JsonObject {
  fields?: {
    title?: Record<string, string>;
    file?: Record<string, { url?: string }>;
  };
  sys: RawSys;
}

/**
 * A CMA collection page.
 *
 * @typeParam T - Raw item structure expected from the requested endpoint.
 * @remarks An absent total is unknown, not zero; callers must preserve that distinction.
 */
export interface Collection<T> {
  items: T[];
  /** Total matching items across pages, when the endpoint returns it. */
  total?: number;
}

type RichTextReferenceNode = (typeof RICH_TEXT_REFERENCE_NODES)[number][0];

interface ContentTypeReferenceValidation extends JsonObject {
  in?: (string | number)[];
  linkContentType?: string[];
  range?: { min?: number; max?: number };
  size?: { min?: number; max?: number };
}

/* Consumed field/item schema and reference restrictions; not the complete CMA validation vocabulary. */
/**
 * Consumed field or array-item schema and reference constraints, excluding unused CMA validation vocabulary.
 */
export interface ContentTypeField extends JsonObject {
  linkType?: string;
  type: string;
  validations?: (ContentTypeReferenceValidation & {
    enabledNodeTypes?: string[];
    enabledMarks?: string[];
    nodes?: Partial<
      Record<RichTextReferenceNode, ContentTypeReferenceValidation[]>
    >;
  })[];
}

/* Content-type identity and fields used by discovery and shared write validation. */
/**
 * Content type identity and field definitions used for schema discovery and write validation.
 */
export interface RawContentType extends JsonObject {
  /** Editor-facing explanation of what the content type is for. */
  description?: string;
  displayField?: string;
  fields: (ContentTypeField & {
    id: string;
    name: string;
    required?: boolean;
    localized?: boolean;
    disabled?: boolean;
    omitted?: boolean;
    items?: ContentTypeField;
  })[];
  name: string;
  sys: { id: string };
}

/* CMA entry with optional metadata, retained by queries and preserved during field updates. */
/**
 * CMA entry with optional metadata preserved through queries and field updates.
 */
export interface RawQueryEntry extends RawEntry {
  metadata?: JsonObject;
}
