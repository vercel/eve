/**
 * Declarative field checking for durable wire envelopes.
 *
 * Wire families declare each version's shape as a table of discriminator →
 * fields, and this module validates an envelope against one such entry,
 * returning only the fields the table declares. It is deliberately tiny and
 * dependency-free: wire modules are reached from the workflow driver body,
 * whose bundle is self-contained and base64-embedded, so a vendored schema
 * library costs several times its own size there (see
 * research/session-inbox-wire-schema.md).
 *
 * Validation stops at the envelope. Interiors owned by other subsystems
 * (adapter payloads, auth contexts) are asserted to be objects and never
 * rewritten, so adding an adapter field is not a wire change.
 */

/** Field kinds an envelope may declare. */
export type FieldType = "object" | "object-or-null" | "object[]" | "string" | "turn-policy";

/** A field's declared type; a `?` suffix marks it optional. */
export type FieldSpec = FieldType | `${FieldType}?`;

/** One version's fields for a single discriminator value. */
export type FieldSpecs = Readonly<Record<string, FieldSpec>>;

/** A whole version's shape: discriminator value → its fields. */
export type FieldTable = Readonly<Record<string, FieldSpecs>>;

/** Raised when an envelope does not match its declared fields. */
export class WireFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireFieldError";
  }
}

const CHECKS: Readonly<Record<FieldType, (value: unknown) => boolean>> = {
  object: isObject,
  "object-or-null": (value) => value === null || isObject(value),
  "object[]": (value) => Array.isArray(value) && value.every(isObject),
  string: (value) => typeof value === "string",
  "turn-policy": (value) => value === "queue" || value === "steer",
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Copies the fields `specs` declares from `value`, validating each.
 *
 * Undeclared keys are omitted rather than rejected: discarding cannot lose
 * declared data, while rejecting would risk refusing payloads written by an
 * older producer that attached a field this version never knew about.
 * Declared values are copied by reference, so envelope-internal aliasing
 * survives.
 *
 * @throws WireFieldError when a required field is absent or a present field
 * has the wrong type.
 */
export function pickDeclaredFields(input: {
  readonly label: string;
  readonly specs: FieldSpecs;
  readonly value: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const [field, spec] of Object.entries(input.specs)) {
    const optional = spec.endsWith("?");
    const type = (optional ? spec.slice(0, -1) : spec) as FieldType;
    const candidate = input.value[field];

    if (candidate === undefined) {
      if (!optional) {
        throw new WireFieldError(`${input.label} is missing required field "${field}".`);
      }
      continue;
    }

    if (!CHECKS[type](candidate)) {
      throw new WireFieldError(`${input.label} field "${field}" is not ${type}.`);
    }
    picked[field] = candidate;
  }

  return picked;
}

/**
 * Resolves the table entry for an envelope's discriminator.
 *
 * @throws WireFieldError when the discriminator is absent or unknown, naming
 * the values this version accepts.
 */
export function resolveFieldSpecs(input: {
  readonly discriminator: unknown;
  readonly label: string;
  readonly table: FieldTable;
}): FieldSpecs {
  // `Object.hasOwn`, not a bare lookup: a discriminator of `"toString"` or
  // `"constructor"` would otherwise resolve an inherited prototype member and
  // sail through with no fields checked.
  const specs =
    typeof input.discriminator === "string" && Object.hasOwn(input.table, input.discriminator)
      ? input.table[input.discriminator]
      : undefined;
  if (specs === undefined) {
    throw new WireFieldError(
      `${input.label} has an unrecognized kind ${JSON.stringify(input.discriminator)}; expected ${Object.keys(input.table).join(" | ")}.`,
    );
  }
  return specs;
}
