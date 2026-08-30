import type { StepInput } from "#harness/types.js";
import {
  isJsonObjectValue,
  jsonValuesEqual,
  type JsonArray,
  type JsonObject,
  type JsonValue,
} from "#shared/json.js";

/**
 * Narrowed form of {@link StepInput} whose `message` is always a plain string.
 * Delegated child runs receive a synthesized text-only prompt.
 */
export interface FormattedSubagentInvocation extends StepInput {
  readonly message: string;
}

/**
 * Normalizes the `outputSchema` a model passed on a subagent tool call.
 * Models routinely send an empty `{}` despite the tool schema saying to omit
 * it; an empty JSON Schema constrains nothing, but honoring it flips the
 * child into structured-output mode and discards its text reply. Only a
 * non-empty object counts as a requested schema — local and remote dispatch
 * share this rule.
 */
export function normalizeRequestedOutputSchema(
  outputSchema: JsonValue | undefined,
): JsonObject | undefined {
  return isJsonObjectValue(outputSchema) && Object.keys(outputSchema).length > 0
    ? outputSchema
    : undefined;
}

const SCHEMA_COMPOSITION_KEYS = new Set(["$ref", "allOf", "anyOf", "if", "not", "oneOf"]);
const SCHEMA_PROPERTY_EVALUATION_KEYS = new Set(["patternProperties", "unevaluatedProperties"]);
const SCHEMA_ANNOTATION_KEYS = new Set([
  "$comment",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);
const LOWER_BOUND_KEYS = new Set([
  "exclusiveMinimum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
]);
const UPPER_BOUND_KEYS = new Set([
  "exclusiveMaximum",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
]);
const NON_NEGATIVE_INTEGER_KEYS = new Set([
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
]);
const SCHEMA_NODE_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
]);
const STRING_SCHEMA_KEYS = new Set([
  "$comment",
  "$id",
  "$schema",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
]);
const BOOLEAN_SCHEMA_KEYS = new Set(["deprecated", "readOnly", "uniqueItems", "writeOnly"]);
const SUPPORTED_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

/**
 * Resolves the schema for a fresh subagent turn. A per-call schema refines an
 * agent declaration; it cannot replace or weaken that declaration.
 */
export function resolveSubagentOutputSchema(input: {
  readonly declared: JsonObject | undefined;
  readonly requested: JsonValue | undefined;
}): JsonObject | undefined {
  const requested = normalizeRequestedOutputSchema(input.requested);
  if (input.declared === undefined) return requested;
  if (requested === undefined) return input.declared;
  return intersectJsonSchemaObjects(input.declared, requested, "outputSchema");
}

function intersectJsonSchemaObjects(
  declared: JsonObject,
  requested: JsonObject,
  path: string,
): JsonObject {
  for (const key of SCHEMA_COMPOSITION_KEYS) {
    if (Object.hasOwn(declared, key) || Object.hasOwn(requested, key)) {
      throw schemaIntersectionError(path, `cannot flatten the composition keyword "${key}"`);
    }
  }
  for (const key of SCHEMA_PROPERTY_EVALUATION_KEYS) {
    if (Object.hasOwn(declared, key) || Object.hasOwn(requested, key)) {
      throw schemaIntersectionError(
        path,
        `cannot flatten the property-evaluation keyword "${key}"`,
      );
    }
  }
  validateFlattenableSchemaObject(declared, path);
  validateFlattenableSchemaObject(requested, path);

  const result: Record<string, JsonValue> = {};
  const keys = new Set([...Object.keys(declared), ...Object.keys(requested)]);

  for (const key of keys) {
    const declaredHas = Object.hasOwn(declared, key);
    const requestedHas = Object.hasOwn(requested, key);
    const declaredValue = declared[key];
    const requestedValue = requested[key];

    if (key === "properties") {
      result[key] = intersectProperties({
        declared: declaredHas ? declaredValue : {},
        declaredAdditionalProperties: declared.additionalProperties,
        path: `${path}.${key}`,
        requested: requestedHas ? requestedValue : {},
        requestedAdditionalProperties: requested.additionalProperties,
      });
      continue;
    }

    if (key === "required") {
      result[key] = unionStringArrays(
        declaredHas ? declaredValue : [],
        requestedHas ? requestedValue : [],
        `${path}.${key}`,
      );
      continue;
    }

    if (!declaredHas) {
      result[key] = requestedValue!;
      continue;
    }
    if (!requestedHas) {
      result[key] = declaredValue!;
      continue;
    }

    if (SCHEMA_ANNOTATION_KEYS.has(key)) {
      result[key] = declaredValue!;
      continue;
    }

    if (LOWER_BOUND_KEYS.has(key)) {
      result[key] = Math.max(
        readNumericKeyword(declaredValue, path, key),
        readNumericKeyword(requestedValue, path, key),
      );
      continue;
    }

    if (UPPER_BOUND_KEYS.has(key)) {
      result[key] = Math.min(
        readNumericKeyword(declaredValue, path, key),
        readNumericKeyword(requestedValue, path, key),
      );
      continue;
    }

    switch (key) {
      case "additionalProperties":
        result[key] = intersectSchemaNodes(declaredValue, requestedValue, `${path}.${key}`);
        break;
      case "const":
        if (!jsonValuesEqual(declaredValue, requestedValue)) {
          throw schemaIntersectionError(`${path}.${key}`, "declared and requested values conflict");
        }
        result[key] = declaredValue!;
        break;
      case "enum":
        result[key] = intersectEnumValues(declaredValue, requestedValue, `${path}.${key}`);
        break;
      case "items":
        result[key] = intersectItems(declaredValue, requestedValue, `${path}.${key}`);
        break;
      case "type":
        result[key] = intersectTypes(declaredValue, requestedValue, `${path}.${key}`);
        break;
      case "uniqueItems":
        result[key] =
          readBooleanKeyword(declaredValue, path, key) ||
          readBooleanKeyword(requestedValue, path, key);
        break;
      default:
        if (!jsonValuesEqual(declaredValue, requestedValue)) {
          throw schemaIntersectionError(
            `${path}.${key}`,
            "cannot flatten differing values for this keyword",
          );
        }
        result[key] = declaredValue!;
    }
  }

  assertCompatibleBounds(result, path, "minItems", "maxItems");
  assertCompatibleBounds(result, path, "minLength", "maxLength");
  assertCompatibleBounds(result, path, "minProperties", "maxProperties");
  assertCompatibleBounds(result, path, "minimum", "maximum");
  assertCompatibleBounds(result, path, "exclusiveMinimum", "exclusiveMaximum");
  assertCompatibleBounds(result, path, "minContains", "maxContains");
  assertClosedObjectRequirements(result, path);
  return result;
}

function validateFlattenableSchemaObject(schema: JsonObject, path: string): void {
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_COMPOSITION_KEYS.has(key)) {
      throw schemaIntersectionError(path, `cannot flatten the composition keyword "${key}"`);
    }
    if (SCHEMA_PROPERTY_EVALUATION_KEYS.has(key)) {
      throw schemaIntersectionError(
        path,
        `cannot flatten the property-evaluation keyword "${key}"`,
      );
    }

    if (STRING_SCHEMA_KEYS.has(key)) {
      if (typeof value !== "string") {
        throw schemaIntersectionError(`${path}.${key}`, "expected a string");
      }
      continue;
    }

    if (BOOLEAN_SCHEMA_KEYS.has(key)) {
      if (typeof value !== "boolean") {
        throw schemaIntersectionError(`${path}.${key}`, "expected a boolean");
      }
      continue;
    }

    if (NON_NEGATIVE_INTEGER_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw schemaIntersectionError(`${path}.${key}`, "expected a non-negative integer");
      }
      continue;
    }

    if (LOWER_BOUND_KEYS.has(key) || UPPER_BOUND_KEYS.has(key)) {
      if (typeof value !== "number") {
        throw schemaIntersectionError(`${path}.${key}`, "expected a number");
      }
      continue;
    }

    if (SCHEMA_NODE_KEYS.has(key)) {
      validateSchemaNode(value, `${path}.${key}`);
      continue;
    }

    switch (key) {
      case "const":
      case "default":
        break;
      case "enum":
        if (!Array.isArray(value) || value.length === 0) {
          throw schemaIntersectionError(`${path}.${key}`, "expected a non-empty array");
        }
        break;
      case "examples":
        if (!Array.isArray(value)) {
          throw schemaIntersectionError(`${path}.${key}`, "expected an array");
        }
        break;
      case "items":
        if (Array.isArray(value)) {
          value.forEach((item, index) => validateSchemaNode(item, `${path}.${key}[${index}]`));
        } else {
          validateSchemaNode(value, `${path}.${key}`);
        }
        break;
      case "multipleOf":
        if (typeof value !== "number" || value <= 0) {
          throw schemaIntersectionError(`${path}.${key}`, "expected a positive number");
        }
        break;
      case "properties":
        if (!isJsonObjectValue(value)) {
          throw schemaIntersectionError(`${path}.${key}`, "expected a property map");
        }
        for (const [name, propertySchema] of Object.entries(value)) {
          validateSchemaNode(propertySchema, `${path}.${key}.${name}`);
        }
        break;
      case "required":
        if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
          throw schemaIntersectionError(`${path}.${key}`, "expected a string array");
        }
        break;
      case "type":
        readTypeNames(value, `${path}.${key}`);
        break;
      default:
        throw schemaIntersectionError(`${path}.${key}`, "unsupported schema keyword");
    }
  }
}

function validateSchemaNode(value: JsonValue, path: string): void {
  if (typeof value === "boolean") return;
  if (isJsonObjectValue(value)) {
    validateFlattenableSchemaObject(value, path);
    return;
  }
  throw schemaIntersectionError(path, "expected a boolean or object schema");
}

function intersectSchemaNodes(
  declared: JsonValue | undefined,
  requested: JsonValue | undefined,
  path: string,
): JsonValue {
  if (declared === false || requested === false) return false;
  if (declared === true) return requested!;
  if (requested === true) return declared!;
  if (isJsonObjectValue(declared) && isJsonObjectValue(requested)) {
    return intersectJsonSchemaObjects(declared, requested, path);
  }
  throw schemaIntersectionError(path, "expected boolean or object schemas");
}

function intersectItems(
  declared: JsonValue | undefined,
  requested: JsonValue | undefined,
  path: string,
): JsonValue {
  if (Array.isArray(declared) || Array.isArray(requested)) {
    if (jsonValuesEqual(declared, requested)) return declared!;
    throw schemaIntersectionError(path, "cannot flatten differing tuple schemas");
  }
  return intersectSchemaNodes(declared, requested, path);
}

function intersectProperties(input: {
  readonly declared: JsonValue | undefined;
  readonly declaredAdditionalProperties: JsonValue | undefined;
  readonly path: string;
  readonly requested: JsonValue | undefined;
  readonly requestedAdditionalProperties: JsonValue | undefined;
}): JsonObject {
  const { declared, path, requested } = input;
  if (!isJsonObjectValue(declared) || !isJsonObjectValue(requested)) {
    throw schemaIntersectionError(path, "expected property maps");
  }

  const properties: Record<string, JsonValue> = {};
  const names = new Set([...Object.keys(declared), ...Object.keys(requested)]);
  for (const name of names) {
    const declaredHas = Object.hasOwn(declared, name);
    const requestedHas = Object.hasOwn(requested, name);
    if (declaredHas && requestedHas) {
      properties[name] = intersectSchemaNodes(declared[name], requested[name], `${path}.${name}`);
      continue;
    }

    const constrained = declaredHas
      ? constrainExplicitProperty({
          additionalProperties: input.requestedAdditionalProperties,
          explicit: declared[name]!,
          path: `${path}.${name}`,
        })
      : constrainExplicitProperty({
          additionalProperties: input.declaredAdditionalProperties,
          explicit: requested[name]!,
          path: `${path}.${name}`,
        });
    if (constrained !== undefined) properties[name] = constrained;
  }
  return properties;
}

function constrainExplicitProperty(input: {
  readonly additionalProperties: JsonValue | undefined;
  readonly explicit: JsonValue;
  readonly path: string;
}): JsonValue | undefined {
  if (input.additionalProperties === false) return undefined;
  if (input.additionalProperties === undefined || input.additionalProperties === true) {
    return input.explicit;
  }
  if (isJsonObjectValue(input.additionalProperties)) {
    return intersectSchemaNodes(input.explicit, input.additionalProperties, input.path);
  }
  throw schemaIntersectionError(
    input.path,
    "expected additionalProperties to be boolean or object",
  );
}

function intersectEnumValues(
  declared: JsonValue | undefined,
  requested: JsonValue | undefined,
  path: string,
): JsonArray {
  if (!Array.isArray(declared) || !Array.isArray(requested)) {
    throw schemaIntersectionError(path, "expected arrays");
  }
  const intersection = declared.filter((value) =>
    requested.some((candidate) => jsonValuesEqual(value, candidate)),
  );
  if (intersection.length === 0) {
    throw schemaIntersectionError(path, "declared and requested enums do not overlap");
  }
  return intersection;
}

function intersectTypes(
  declared: JsonValue | undefined,
  requested: JsonValue | undefined,
  path: string,
): JsonValue {
  const declaredTypes = readTypeNames(declared, path);
  const requestedTypes = readTypeNames(requested, path);
  const intersection = declaredTypes.filter((type) => requestedTypes.includes(type));
  if (intersection.length === 0) {
    throw schemaIntersectionError(path, "declared and requested types do not overlap");
  }
  return intersection.length === 1 ? intersection[0]! : intersection;
}

function readTypeNames(value: JsonValue | undefined, path: string): readonly string[] {
  const types = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (
    types !== undefined &&
    types.length > 0 &&
    types.every((entry) => typeof entry === "string" && SUPPORTED_SCHEMA_TYPES.has(entry)) &&
    new Set(types).size === types.length
  ) {
    return types as readonly string[];
  }
  throw schemaIntersectionError(path, "expected a string or string array");
}

function unionStringArrays(
  declared: JsonValue | undefined,
  requested: JsonValue | undefined,
  path: string,
): JsonArray {
  if (
    !Array.isArray(declared) ||
    !declared.every((value) => typeof value === "string") ||
    !Array.isArray(requested) ||
    !requested.every((value) => typeof value === "string")
  ) {
    throw schemaIntersectionError(path, "expected string arrays");
  }
  return [...new Set([...declared, ...requested])];
}

function readNumericKeyword(value: JsonValue | undefined, path: string, key: string): number {
  if (typeof value === "number") return value;
  throw schemaIntersectionError(`${path}.${key}`, "expected a number");
}

function readBooleanKeyword(value: JsonValue | undefined, path: string, key: string): boolean {
  if (typeof value === "boolean") return value;
  throw schemaIntersectionError(`${path}.${key}`, "expected a boolean");
}

function assertCompatibleBounds(
  schema: JsonObject,
  path: string,
  lowerKey: string,
  upperKey: string,
): void {
  const lower = schema[lowerKey];
  const upper = schema[upperKey];
  if (typeof lower === "number" && typeof upper === "number" && lower > upper) {
    throw schemaIntersectionError(path, `${lowerKey} exceeds ${upperKey}`);
  }
}

function assertClosedObjectRequirements(schema: JsonObject, path: string): void {
  if (schema.additionalProperties !== false || !Array.isArray(schema.required)) return;
  const properties = schema.properties;
  if (!isJsonObjectValue(properties)) {
    throw schemaIntersectionError(path, "a closed object requires an explicit property map");
  }
  const missing = schema.required.filter(
    (name) => typeof name === "string" && !Object.hasOwn(properties, name),
  );
  if (missing.length > 0) {
    throw schemaIntersectionError(
      path,
      `required properties are forbidden by the other schema: ${missing.join(", ")}`,
    );
  }
}

function schemaIntersectionError(path: string, detail: string): TypeError {
  return new TypeError(`Cannot narrow the declared output schema at ${path}: ${detail}.`);
}

type RuntimeSubagentInputFormatRequest = {
  readonly message: string;
  readonly name: string;
  readonly type: "runtime";
};

type LocalSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: string;
  readonly name: string;
  readonly type: "local";
};

type RemoteSubagentInputFormatRequest = {
  readonly description: string;
  readonly message: string;
  readonly name: string;
  readonly type: "remote";
};

type SubagentInputFormatRequest =
  | RuntimeSubagentInputFormatRequest
  | LocalSubagentInputFormatRequest
  | RemoteSubagentInputFormatRequest;

type SubagentInputFormatters = {
  readonly runtime: (input: RuntimeSubagentInputFormatRequest) => FormattedSubagentInvocation;
  readonly local: (input: LocalSubagentInputFormatRequest) => FormattedSubagentInvocation;
  readonly remote: (input: RemoteSubagentInputFormatRequest) => FormattedSubagentInvocation;
};

const formatSubagentInputByType = {
  runtime(input) {
    return formatSubagentPrompt({
      descriptionLines: [],
      message: input.message,
      name: input.name,
    });
  },
  local(input) {
    return formatSubagentPrompt({
      descriptionLines: formatDescriptionLines(input.description),
      message: input.message,
      name: input.name,
    });
  },
  remote(input) {
    return formatSubagentPrompt({
      descriptionLines: formatDescriptionLines(input.description),
      message: input.message,
      name: input.name,
    });
  },
} satisfies SubagentInputFormatters;

/**
 * Formats the stable delegated input handed to one child agent invocation.
 */
export function formatSubagentInput(
  input: SubagentInputFormatRequest,
): FormattedSubagentInvocation {
  switch (input.type) {
    case "runtime":
      return formatSubagentInputByType.runtime(input);
    case "local":
      return formatSubagentInputByType.local(input);
    case "remote":
      return formatSubagentInputByType.remote(input);
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

function formatSubagentPrompt(input: {
  readonly descriptionLines: readonly string[];
  readonly message: string;
  readonly name: string;
}): FormattedSubagentInvocation {
  return {
    message: [
      `You are the subagent "${input.name}".`,
      ...input.descriptionLines,
      "",
      "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer.",
      "",
      "Caller message:",
      input.message,
    ].join("\n"),
  };
}

function formatDescriptionLines(description: string): readonly string[] {
  return description.trim().length > 0 ? [`Description: ${description}`] : [];
}
