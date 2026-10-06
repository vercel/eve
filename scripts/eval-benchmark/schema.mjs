// Minimal JSON Schema validator for record.schema.json. It covers exactly the
// keywords that schema uses, so the contract needs no new dependency.
import { readFileSync } from "node:fs";

export const RECORD_SCHEMA = JSON.parse(
  readFileSync(new URL("./record.schema.json", import.meta.url), "utf8"),
);

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "format",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "pattern",
  "minLength",
  "minimum",
  "maximum",
  "oneOf",
]);

/** @returns {string[]} human-readable errors; empty when valid */
export function validate(value, schema = RECORD_SCHEMA, root = schema, path = "$") {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword))
      throw new Error(`Unsupported schema keyword "${keyword}" at ${path}.`);
  }
  if (schema.$ref !== undefined) {
    const target = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((node, key) => node?.[key], root);
    if (target === undefined) throw new Error(`Unresolved schema reference ${schema.$ref}.`);
    return validate(value, target, root, path);
  }
  const errors = [];
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((type) => hasType(value, type)))
      return [`${path}: expected ${types.join(" or ")}, got ${describe(value)}`];
  }
  if ("const" in schema && value !== schema.const)
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      errors.push(...validate(item, schema.items, root, `${path}[${index}]`)),
    );
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property !== undefined) errors.push(...validate(item, property, root, `${path}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unexpected property "${key}"`);
      else if (isObject(schema.additionalProperties))
        errors.push(...validate(item, schema.additionalProperties, root, `${path}.${key}`));
    }
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(
      (option) => validate(value, option, root, path).length === 0,
    );
    if (matches.length !== 1)
      errors.push(`${path}: must match exactly one schema option (matched ${matches.length})`);
  }
  return errors;
}

function hasType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
