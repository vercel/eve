import { Validator } from "#compiled/@cfworker/json-schema/index.js";
import type { JsonObject } from "#shared/json.js";

const schema = { $ref: "#" };
const schemaList = { type: "array", minItems: 1, items: schema };
const propertyName = {
  type: "string",
  not: { enum: Object.getOwnPropertyNames(Object.prototype) },
};
const schemaMap = { type: "object", propertyNames: propertyName, additionalProperties: schema };
const strings = { type: "array", uniqueItems: true, items: propertyName };
const nonnegativeInteger = { type: "integer", minimum: 0 };
const jsonType = { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] };

const constraintSchema = new Validator(
  {
    anyOf: [
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            anyOf: [jsonType, { type: "array", minItems: 1, uniqueItems: true, items: jsonType }],
          },
          const: { type: ["string", "number", "boolean", "null"] },
          enum: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: ["string", "number", "boolean", "null"] },
          },
          title: { type: "string" },
          description: { type: "string" },
          default: true,
          minimum: { type: "number" },
          maximum: { type: "number" },
          exclusiveMinimum: { type: "number" },
          exclusiveMaximum: { type: "number" },
          minLength: nonnegativeInteger,
          maxLength: nonnegativeInteger,
          pattern: { type: "string", format: "regex" },
          minItems: nonnegativeInteger,
          maxItems: nonnegativeInteger,
          items: schema,
          prefixItems: schemaList,
          contains: schema,
          minProperties: nonnegativeInteger,
          maxProperties: nonnegativeInteger,
          properties: schemaMap,
          propertyNames: schema,
          required: strings,
          additionalProperties: schema,
          allOf: schemaList,
          anyOf: schemaList,
          oneOf: schemaList,
          not: schema,
          if: schema,
          // oxlint-disable-next-line unicorn/no-thenable
          then: schema,
          else: schema,
        },
      },
    ],
  },
  "2020-12",
);

export function validateStubConstraint(value: unknown, ruleId: string, property: string): void {
  const result = constraintSchema.validate(value);
  if (!result.valid) {
    const error = result.errors.at(-1)!;
    const detail = error.keyword === "false" ? "Unsupported JSON Schema keyword." : error.error;
    throw new Error(
      `Invalid matcher "${property}" in tool stub "${ruleId}" at ${error.instanceLocation}: ${detail}`,
    );
  }
}

export function createStubValidator(value: JsonObject | boolean): Validator {
  return new Validator(structuredClone(value), "2020-12");
}
