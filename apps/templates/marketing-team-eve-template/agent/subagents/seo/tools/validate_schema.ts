import { defineTool } from "eve/tools";
import { z } from "zod";
import requiredPropertiesFile from "../skills/schema/references/required-properties.json" with {
  type: "json",
};

/**
 * Maximum length of the JSON-LD accepted, in characters.
 */
const MAX_JSON_LENGTH = 100_000;

/**
 * Schema for `required-properties.json`: a map of `@type` to the properties Google needs.
 */
const REQUIRED_PROPERTIES_SCHEMA = z.record(z.string(), z.array(z.string()));

/**
 * The `schema` skill's required-property map, or `null` when the file doesn't match its schema.
 *
 * @remarks
 * Imported from the skill's own `references/required-properties.json`, so the skill stays the
 * source of truth: its `SKILL.md` table and that file list the same types, and adding one is a
 * skill edit rather than a code change. Validated once, when the module loads.
 */
const REQUIRED_PROPERTIES: Record<string, string[]> | null = (() => {
  const parsed = REQUIRED_PROPERTIES_SCHEMA.safeParse(requiredPropertiesFile);
  return parsed.success ? parsed.data : null;
})();

/**
 * Properties whose value must be an ISO 8601 date or date-time.
 */
const DATE_PROPERTIES = new Set([
  "datePublished",
  "dateModified",
  "startDate",
  "endDate",
  "priceValidUntil",
  "validFrom",
  "validThrough",
]);

/**
 * Properties whose value must be an absolute URL when it is a string.
 *
 * @remarks
 * `image` and `item` also accept an object or an array in schema.org, so those shapes are left
 * alone and only a bare string is checked.
 */
const URL_PROPERTIES = new Set(["url", "logo", "image", "item", "target"]);

/** ISO 8601 date, optionally with a time and offset. */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Absolute http(s) URL. */
const ABSOLUTE_URL = /^https?:\/\//;

/** One node of a JSON-LD document, as parsed. */
type JsonLdNode = Record<string, unknown>;

/**
 * Flatten a parsed JSON-LD document into the nodes worth checking.
 *
 * @remarks
 * A document is either a single entity or an `@graph` array of them. Both shapes are valid, and the
 * `schema` skill recommends `@graph` when a page carries several types, so both are supported here.
 *
 * @param doc - Parsed JSON-LD.
 * @returns The entity nodes, or an empty array when the shape isn't recognized.
 */
const nodesOf = (doc: unknown): JsonLdNode[] => {
  if (Array.isArray(doc)) {
    return doc.filter(
      (n): n is JsonLdNode => typeof n === "object" && n !== null
    );
  }
  if (typeof doc !== "object" || doc === null) {
    return [];
  }
  const node = doc as JsonLdNode;
  const graph = node["@graph"];
  if (Array.isArray(graph)) {
    return graph.filter(
      (n): n is JsonLdNode => typeof n === "object" && n !== null
    );
  }
  return [node];
};

/**
 * Read a node's `@type` values.
 *
 * @param node - One JSON-LD entity.
 * @returns Every declared type, since `@type` may be an array.
 */
const typesOf = (node: JsonLdNode): string[] => {
  const type = node["@type"];
  if (typeof type === "string") {
    return [type];
  }
  return Array.isArray(type) ? type.filter((t) => typeof t === "string") : [];
};

/**
 * Check one node's required properties against the map.
 *
 * @param node - One JSON-LD entity.
 * @param required - The map imported from the skill.
 * @returns One message per missing required property.
 */
const missingRequired = (
  node: JsonLdNode,
  required: Record<string, string[]>
): string[] => {
  const problems: string[] = [];
  for (const type of typesOf(node)) {
    for (const property of required[type] ?? []) {
      if (node[property] === undefined || node[property] === null) {
        problems.push(
          `${type} is missing the required property "${property}".`
        );
      }
    }
  }
  return problems;
};

/**
 * Check a node's date and URL values for the shapes Google rejects.
 *
 * @param node - One JSON-LD entity.
 * @returns One message per malformed value.
 */
const malformedValues = (node: JsonLdNode): string[] => {
  const problems: string[] = [];
  const label = typesOf(node)[0] ?? "node";
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string") {
      continue;
    }
    if (DATE_PROPERTIES.has(key) && !ISO_8601.test(value)) {
      problems.push(`${label}.${key} is not an ISO 8601 date: "${value}".`);
    }
    if (URL_PROPERTIES.has(key) && !ABSOLUTE_URL.test(value)) {
      problems.push(`${label}.${key} must be an absolute URL: "${value}".`);
    }
  }
  return problems;
};

/**
 * Tool that checks a JSON-LD block before it ships.
 *
 * @remarks
 * Mechanical checks only, and that boundary is the point. It parses the JSON, confirms each entity
 * declares a `@type` and carries the properties the `schema` skill lists for it, and catches the
 * two value shapes that fail most often: a date that isn't ISO 8601 and a relative URL. It cannot
 * tell whether the markup describes what the page actually shows, which is the failure that earns a
 * manual action, so a clean result is a floor rather than approval.
 *
 * The required-property map is imported from the skill, so the `SKILL.md` table and the validator
 * can't drift. When that file doesn't validate the result is an error rather than a warning,
 * and `valid` goes false: a validator that skips its main check and still reports clean is worse
 * than one that fails, because the caller acts on `valid` and not on the prose beside it.
 */
export default defineTool({
  description:
    "Check a JSON-LD block for the mistakes that stop it working: invalid JSON, a missing @type, " +
    "a required property absent for that type, a date that isn't ISO 8601, or a relative URL. " +
    "Run it on any markup before handing it over. A clean result means the syntax is right, not " +
    "that the markup matches what the page shows, so the accuracy rule in the schema skill still " +
    "applies.",
  /**
   * Validate the supplied JSON-LD.
   *
   * @param input - Validated tool input.
   * @returns `valid`, the `types` found, plus `errors` and `warnings`.
   */
  execute({ jsonld }) {
    let doc: unknown;
    try {
      doc = JSON.parse(jsonld);
    } catch (error) {
      return {
        errors: [
          `Not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
        ],
        types: [],
        valid: false,
        warnings: [],
      };
    }

    const required = REQUIRED_PROPERTIES;

    const nodes = nodesOf(doc);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (nodes.length === 0) {
      errors.push(
        "No JSON-LD entity found. Expected an object, an array, or an @graph."
      );
    }
    const isPlainObject =
      typeof doc === "object" && doc !== null && !Array.isArray(doc);
    if (isPlainObject && !(doc as JsonLdNode)["@context"]) {
      warnings.push('Top level is missing "@context": "https://schema.org".');
    }
    if (!required) {
      errors.push(
        "The schema skill's required-property map is malformed, so the per-type checks did not " +
          "run. This block is unchecked rather than clean."
      );
    }

    const types: string[] = [];
    for (const node of nodes) {
      const nodeTypes = typesOf(node);
      if (nodeTypes.length === 0) {
        errors.push("An entity has no @type.");
      }
      types.push(...nodeTypes);
      if (required) {
        errors.push(...missingRequired(node, required));
      }
      errors.push(...malformedValues(node));
    }

    return { errors, types, valid: errors.length === 0, warnings };
  },
  inputSchema: z.object({
    jsonld: z
      .string()
      .min(1)
      .max(MAX_JSON_LENGTH)
      .describe(
        "The JSON-LD to check, as it would appear inside the script tag. Just the JSON, without " +
          "the surrounding <script> element."
      ),
  }),
  outputSchema: z.object({
    errors: z
      .array(z.string())
      .describe("Problems that will stop this working. Fix all of them."),
    types: z
      .array(z.string())
      .describe(
        "Every @type found, so you can confirm the block says what you meant."
      ),
    valid: z
      .boolean()
      .describe(
        "True when there are no errors. Says the syntax is right, not that the markup matches " +
          "the page."
      ),
    warnings: z
      .array(z.string())
      .describe("Worth looking at, including any check that could not be run."),
  }),
});
