import { types } from "pg";
import type { CustomTypesConfig } from "pg";
import { z } from "zod";

import type { JsonValue } from "#lib/json";
import { isBigInt, isNumber, isString } from "#lib/values";

/* date, time, timestamp, timestamptz, interval, timetz, and their array types */
const RAW_TEXT_OIDS = new Set([
  1082, 1083, 1114, 1184, 1186, 1266, 1182, 1183, 1115, 1185, 1187, 1270,
]);

const TYPE_NAMES = new Map([
  [16, "boolean"],
  [18, "char"],
  [19, "name"],
  [20, "bigint"],
  [21, "smallint"],
  [23, "integer"],
  [25, "text"],
  [26, "oid"],
  [114, "json"],
  [700, "real"],
  [701, "double precision"],
  [790, "money"],
  [869, "inet"],
  [1000, "boolean[]"],
  [1007, "integer[]"],
  [1009, "text[]"],
  [1016, "bigint[]"],
  [1042, "character"],
  [1043, "varchar"],
  [1082, "date"],
  [1083, "time"],
  [1114, "timestamp"],
  [1184, "timestamptz"],
  [1186, "interval"],
  [1266, "timetz"],
  [1700, "numeric"],
  [2278, "void"],
  [2950, "uuid"],
  [3802, "jsonb"],
]);

const keepText = (value: string) => value;

/**
 * Per-query type parsers that keep date and time values as Postgres text.
 *
 * @remarks node-postgres otherwise builds `DATE` values at local midnight, which shifts the day when converted to ISO on a server outside UTC. Raw text is rendered in the session time zone, which is the reporting time zone.
 */
export const typeParsers: CustomTypesConfig = {
  // SAFETY: Every branch returns a text-format parser: either node-postgres's own or one that returns the text unchanged.
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    RAW_TEXT_OIDS.has(oid)
      ? keepText
      : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
};

/**
 * Names a result column's Postgres type so the model knows how to read string-encoded numbers.
 *
 * @param oid - The column's `dataTypeID`.
 * @returns A familiar type name, or `oid:<n>` for types without a mapping.
 */
export const columnTypeName = (oid: number): string =>
  TYPE_NAMES.get(oid) ?? `oid:${oid}`;

/** One value as node-postgres parses it; anything unexpected becomes its string form. */
const cellSchema = z.union([
  z.instanceof(Date),
  z.instanceof(Buffer),
  z.bigint(),
  z.nan(),
  z.json(),
  z.unknown().transform(String),
]);

/** A parsed Postgres value before it is bounded for the model. */
export type PostgresCell = z.infer<typeof cellSchema>;

/** Rows returned by node-postgres in array mode. */
export const arrayRowsSchema = z.array(z.array(cellSchema));

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated]` : text;

/**
 * Converts one Postgres value into a bounded, JSON-serializable cell.
 *
 * @param value - Value parsed by node-postgres.
 * @param maxChars - Longest text kept for a string or serialized object.
 * @returns A JSON value; bigints become strings, buffers a byte count, and long values are cut with a marker.
 */
export const toJsonCell = (
  value: PostgresCell,
  maxChars: number
): JsonValue => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `<${value.byteLength} bytes>`;
  }
  if (isBigInt(value)) {
    return value.toString();
  }
  if (isString(value)) {
    return truncate(value, maxChars);
  }
  if (isNumber(value)) {
    return Number.isFinite(value) ? value : String(value);
  }
  if (value === null || value === true || value === false) {
    return value;
  }
  const text = JSON.stringify(value);
  return text.length > maxChars ? truncate(text, maxChars) : value;
};

/** Bounds applied to one query result before it reaches the model. */
export interface ResultLimits {
  readonly maxCellChars: number;
  readonly maxOutputChars: number;
  readonly maxRows: number;
}

/** Rows kept for the model and why any were dropped. */
export interface BoundedRows {
  readonly rows: JsonValue[][];
  readonly truncated: boolean;
  readonly truncatedReason: "output-size" | "row-limit" | null;
}

/**
 * Converts and bounds result rows by row count and serialized size.
 *
 * @param rows - Parsed rows, possibly one more than `maxRows` to detect truncation.
 * @param limits - Row, cell, and total-size bounds.
 * @returns Whole rows that fit, with the reason any rows were dropped.
 */
export const boundRows = (
  rows: readonly (readonly PostgresCell[])[],
  { maxCellChars, maxOutputChars, maxRows }: ResultLimits
): BoundedRows => {
  const kept: JsonValue[][] = [];
  let size = 0;
  for (const row of rows.slice(0, maxRows)) {
    const cells = row.map((value) => toJsonCell(value, maxCellChars));
    size += JSON.stringify(cells).length + 1;
    if (size > maxOutputChars && kept.length > 0) {
      return { rows: kept, truncated: true, truncatedReason: "output-size" };
    }
    kept.push(cells);
  }
  return rows.length > maxRows
    ? { rows: kept, truncated: true, truncatedReason: "row-limit" }
    : { rows: kept, truncated: false, truncatedReason: null };
};
