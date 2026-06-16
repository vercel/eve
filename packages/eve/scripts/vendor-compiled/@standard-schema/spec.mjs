import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Type declarations are copied verbatim from the installed
 * @standard-schema/spec version. The upstream `.d.ts` has zero external
 * imports so no rewrites are needed — `createDeclarationCopier` with an
 * empty rewrite map just performs a verbatim copy.
 *
 * Standard Schema is a published interface contract used directly in
 * eve's public API (`StandardSchemaV1`, `StandardJSONSchemaV1` flow
 * through tool/schema definitions). Tracking upstream verbatim means we
 * pick up minor revisions to the spec automatically without hand-editing
 * a stub that silently drifts.
 */
export default {
  packageName: "@standard-schema/spec",
  compiledPath: "@standard-schema/spec",
  typeOnly: true,
  copyDeclarations: createDeclarationCopier(),
};
