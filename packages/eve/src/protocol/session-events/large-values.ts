// Moving a commit's large values out of line, so a commit a large tool result or image would
// otherwise make unwritable still commits.
//
// A commit is atomic: it holds every fact of one transition and cannot be split across stored
// lines, so it has a hard ceiling (`MAX_SESSION_LINE_BYTES`). The envelope already models the way
// out — each field that may be large has an inline slot and a `…Ref` slot holding a
// `ValueReference` — but nothing ever wrote one, so an oversized commit simply failed, taking its
// step and usually its turn with it.
//
// This module is the writer half of that path. It is pure: it decides which values to move and
// rewrites the line, and the caller supplies the store.

import type { JsonValue, StoredLine, ValueReference } from "./envelope.js";
import { encodeLine, MAX_SESSION_LINE_BYTES } from "./envelope.js";

/** Writes one value to a session-scoped store and describes where it went. */
export type StageValue = (value: JsonValue, size: number) => Promise<ValueReference>;

/**
 * The fields a commit may carry by reference, by fact type: the inline slot and the `…Ref` slot
 * that replaces it. Only these three exist, because only these three carry values a tool or a
 * model can make arbitrarily large.
 *
 * A progress record has no `…Ref` slot and needs none: it is a preview a later fact completes, and
 * the envelope says any progress record may be missing, so an oversized one is dropped rather
 * than referenced: {@link prepareLine} reports it `oversized` and the publisher drops it.
 */
const REFERENCEABLE_FIELDS: Readonly<Record<string, readonly [inline: string, ref: string]>> = {
  "call.requested": ["input", "inputRef"],
  "call.settled": ["output", "outputRef"],
  "content.completed": ["value", "valueRef"],
};

/** How much of a value's JSON a reference keeps inline, so readers can still show something. */
const PREVIEW_LENGTH = 256;

interface Candidate {
  readonly factIndex: number;
  readonly inlineField: string;
  readonly refField: string;
  readonly value: JsonValue;
  readonly size: number;
}

/** Any stored line, whatever fact and progress types its writer parameterizes it with. */
type AnyStoredLine = StoredLine<unknown, unknown>;

const lineEncoder = new TextEncoder();

function encodeBytes(line: AnyStoredLine): Uint8Array {
  return lineEncoder.encode(encodeLine(line));
}

function jsonSize(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : lineEncoder.encode(json).byteLength;
}

/** A short, human-readable prefix of the value, for a reader that shows the reference. */
export function previewOf(value: JsonValue): string {
  const json = JSON.stringify(value) ?? "";
  return json.length <= PREVIEW_LENGTH ? json : `${json.slice(0, PREVIEW_LENGTH)}…`;
}

/** Every value in `line` that could be carried by reference, largest first. */
function candidatesOf(line: AnyStoredLine): Candidate[] {
  if (!("facts" in line)) return [];
  const candidates: Candidate[] = [];
  line.facts.forEach((fact, factIndex) => {
    const { data, type } = fact as { type?: unknown; data?: Record<string, JsonValue> };
    const fields = typeof type === "string" ? REFERENCEABLE_FIELDS[type] : undefined;
    if (fields === undefined || data === undefined) return;
    const [inlineField, refField] = fields;
    const value = data[inlineField];
    // An absent value has nothing to move, and one already carried by reference was moved by an
    // earlier pass or by its writer.
    if (value === undefined || data[refField] !== undefined) return;
    candidates.push({ factIndex, inlineField, refField, value, size: jsonSize(value) });
  });
  return candidates.sort((a, b) => b.size - a.size);
}

function withReference<TLine extends AnyStoredLine>(
  line: TLine,
  candidate: Candidate,
  reference: ValueReference,
): TLine {
  if (!("facts" in line)) return line;
  const facts = line.facts.map((fact, index) => {
    if (index !== candidate.factIndex) return fact;
    const { data, ...rest } = fact as { data: Record<string, unknown> };
    const { [candidate.inlineField]: _moved, ...keptData } = data;
    return { ...rest, data: { ...keptData, [candidate.refField]: reference } };
  });
  // The reference slot belongs to the fact's own data type, so the rewrite stays inside it; the
  // table that names the two slots is keyed by string, which is where the type is lost.
  return { ...line, facts } as TLine;
}

/** A line as it will be written, with the bytes the caller writes and whether they fit. */
export interface PreparedLine<TLine> {
  readonly line: TLine;
  readonly bytes: Uint8Array;
  /** The bytes are still over {@link MAX_SESSION_LINE_BYTES}; nothing is left to move. */
  readonly oversized: boolean;
}

/**
 * Encodes `line`, moving its largest values out of line one at a time until the result fits.
 *
 * The common path is one encode and no store access, which is what the encode the caller needed
 * anyway would have cost: a line that already fits is returned with those exact bytes. Only a
 * line over the limit pays for a move, and only for as many moves as it takes — largest first,
 * because each has to earn its round trip to the store, and one 9 MiB tool result is the whole
 * problem while a 200-byte label beside it would not have helped.
 *
 * A line still too large once every referenceable value has moved comes back `oversized`. That is
 * the honest outcome: the remaining bulk is in fields the envelope has no reference slot for, so
 * there is nothing left to move and the caller has to refuse it.
 */
export async function prepareLine<TLine extends AnyStoredLine>(
  line: TLine,
  stage: StageValue,
): Promise<PreparedLine<TLine>> {
  let bytes = encodeBytes(line);
  if (bytes.byteLength <= MAX_SESSION_LINE_BYTES) {
    return { line, bytes, oversized: false };
  }

  let rewritten = line;
  for (const candidate of candidatesOf(line)) {
    rewritten = withReference(rewritten, candidate, {
      ...(await stage(candidate.value, candidate.size)),
      size: candidate.size,
      preview: previewOf(candidate.value),
    });
    bytes = encodeBytes(rewritten);
    if (bytes.byteLength <= MAX_SESSION_LINE_BYTES) {
      return { line: rewritten, bytes, oversized: false };
    }
  }
  return { line: rewritten, bytes, oversized: true };
}
